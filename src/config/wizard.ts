import {
  REQUIRED_GROUP,
  SETTING_GROUPS,
  maskValue,
  settingsInGroup,
  validateSetting,
} from './settings-schema.js';
import type { Setting, SettingGroup } from './settings-schema.js';

/**
 * The interactive setup conversation.
 *
 * Everything here talks through a tiny injected IO pair rather than to
 * `process.stdin` directly, so the whole flow -- validation loops, `-help`,
 * group gates, aborting -- is driven by scripted answers in tests. The real
 * terminal wiring is one small adapter at the bottom of the file.
 *
 * The shape of a question is deliberately two lines: what it is, and what
 * pressing Enter will do. Anything longer is behind `-help`, because a first
 * run asks about a couple of dozen settings and a paragraph each is a wall.
 */

export interface WizardIo {
  ask(prompt: string): Promise<string>;
  write(text: string): void;
}

export type WizardMode =
  /** First boot with required settings missing: ask only what blocks startup. */
  | 'first-run'
  /** `-config`: walk everything, gating optional groups behind a yes/no. */
  | 'full';

export interface WizardOptions {
  mode: WizardMode;
  /** Values currently in effect, from `.env` and the real environment. */
  current: Record<string, string | undefined>;
  io: WizardIo;
}

export interface WizardResult {
  /** Only the settings that actually changed. `null` means "clear to default". */
  values: Map<string, string | null>;
  /** True when the user backed out; nothing should be written. */
  aborted: boolean;
}

const COMMANDS = [
  ['-help', 'explain this setting in full'],
  ['-clear', 'reset it to the default'],
  ['-skip', 'leave the rest of this section alone'],
  ['-done', 'stop here and save what you have answered'],
  ['-abort', 'quit without saving anything'],
] as const;

/** A directive answer, or `undefined` if it's just a value. */
function asCommand(answer: string): string | undefined {
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed.startsWith('-')) return undefined;
  // `--help` and `help` are both what people actually type.
  const normalized = `-${trimmed.replace(/^-+/, '')}`;
  return COMMANDS.some(([name]) => name === normalized) ? normalized : undefined;
}

/** Wrap prose so `-help` doesn't produce one 600-column line. */
export function wrap(text: string, width = 76, indent = '  '): string {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(indent + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(indent + current);
  return lines.join('\n');
}

/**
 * The second line of a question: what Enter does, and what it's currently set
 * to. Split out so the wording is asserted directly in tests.
 */
export function describeCurrent(setting: Setting, current: string | undefined): string {
  if (current !== undefined && current !== '') {
    return `keep ${maskValue(setting, current)}`;
  }
  if (setting.default !== undefined) return `default ${setting.default}`;
  if (setting.required) {
    return setting.example ? `required, e.g. ${setting.example}` : 'required';
  }
  return setting.example ? `off, e.g. ${setting.example}` : 'off';
}

function hintFor(setting: Setting, current: string | undefined): string {
  const hints = ['-help'];
  const isSet = current !== undefined && current !== '';
  if (isSet && !setting.required) hints.push('-clear');
  if (setting.kind === 'boolean') return `yes/no · ${hints.join(' · ')}`;
  if (setting.choices) return `${setting.choices.join('/')} · ${hints.join(' · ')}`;
  return hints.join(' · ');
}

function writeHelp(io: WizardIo, setting: Setting): void {
  io.write('');
  io.write(wrap(setting.help));
  if (setting.choices) io.write(`  Options: ${setting.choices.join(', ')}`);
  if (setting.default !== undefined) io.write(`  Default: ${setting.default}`);
  if (setting.min !== undefined || setting.max !== undefined) {
    io.write(`  Range: ${setting.min ?? 'any'} to ${setting.max ?? 'any'}`);
  }
  io.write(`  Stored in .env as ${setting.key}.`);
  io.write('');
}

type SettingOutcome =
  | { kind: 'value'; value: string | null }
  | { kind: 'keep' }
  | { kind: 'skip' }
  | { kind: 'done' }
  | { kind: 'abort' };

async function askSetting(
  io: WizardIo,
  setting: Setting,
  current: string | undefined,
): Promise<SettingOutcome> {
  io.write('');
  io.write(`${setting.key} — ${setting.label}`);
  io.write(`  [${describeCurrent(setting, current)}]  ${hintFor(setting, current)}`);

  for (;;) {
    const answer = await io.ask('> ');
    const command = asCommand(answer);

    if (command === '-help') {
      writeHelp(io, setting);
      continue;
    }
    if (command === '-skip') return { kind: 'skip' };
    if (command === '-done') return { kind: 'done' };
    if (command === '-abort') return { kind: 'abort' };
    if (command === '-clear') {
      if (setting.required) {
        io.write(`  ${setting.key} is required and has no default, so it can't be cleared.`);
        continue;
      }
      return { kind: 'value', value: null };
    }

    if (answer.trim() === '') {
      // Enter on a required setting that has nothing behind it isn't an answer.
      if (setting.required && (current === undefined || current === '')) {
        io.write(`  ${setting.key} is required — please enter a value (or -abort to quit).`);
        continue;
      }
      return { kind: 'keep' };
    }

    const result = validateSetting(setting, answer);
    if (!result.ok) {
      io.write(`  ${result.error}`);
      continue;
    }
    if (result.warning) io.write(`  Note: ${result.warning}`);
    return { kind: 'value', value: result.value };
  }
}

function summarize(setting: Setting, current: string | undefined): string {
  if (current !== undefined && current !== '') {
    return `    ${setting.key} = ${maskValue(setting, current)}`;
  }
  if (setting.default !== undefined) return `    ${setting.key} = ${setting.default} (default)`;
  return `    ${setting.key} = (off)`;
}

type GateOutcome = 'enter' | 'skip' | 'done' | 'abort';

/**
 * Show what a group is currently set to and ask whether to touch it. Two dozen
 * unconditional questions is the difference between a wizard people finish and
 * one they Ctrl+C out of.
 */
async function askGroupGate(
  io: WizardIo,
  group: SettingGroup,
  settings: Setting[],
  current: Record<string, string | undefined>,
): Promise<GateOutcome> {
  io.write('');
  io.write(`── ${group} ${'─'.repeat(Math.max(0, 60 - group.length))}`);
  for (const setting of settings) io.write(summarize(setting, current[setting.key]));

  for (;;) {
    io.write('  Change these? [y/N]  (-help to explain them, -done to finish)');
    const answer = await io.ask('> ');
    const command = asCommand(answer);

    if (command === '-help') {
      for (const setting of settings) {
        io.write('');
        io.write(`  ${setting.key} — ${setting.label}`);
        io.write(wrap(setting.help, 74, '    '));
      }
      io.write('');
      continue;
    }
    if (command === '-done') return 'done';
    if (command === '-abort') return 'abort';
    if (command === '-skip') return 'skip';

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '' || trimmed === 'n' || trimmed === 'no') return 'skip';
    if (trimmed === 'y' || trimmed === 'yes') return 'enter';
    io.write('  Please answer y or n.');
  }
}

async function askYesNo(io: WizardIo, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    io.write(question);
    const answer = (await io.ask('> ')).trim().toLowerCase();
    if (answer === '') return fallback;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    io.write('  Please answer y or n.');
  }
}

export async function runWizard(options: WizardOptions): Promise<WizardResult> {
  const { io, mode } = options;
  const current: Record<string, string | undefined> = { ...options.current };
  const values = new Map<string, string | null>();

  const record = (setting: Setting, value: string | null): void => {
    values.set(setting.key, value);
    current[setting.key] = value ?? undefined;
  };

  io.write('');
  if (mode === 'first-run') {
    io.write('Welcome — the bot needs a few details before it can start.');
    io.write('Answer the prompts below; they are saved to .env and only asked once.');
  } else {
    io.write('Bot configuration. Press Enter to keep a setting as it is.');
  }
  io.write('Type -help at any prompt to have that setting explained in full.');
  io.write(
    `Also: ${COMMANDS.filter(([name]) => name !== '-help')
      .map(([name, what]) => `${name} (${what})`)
      .join(', ')}.`,
  );

  // The required group is never gated — without it there is no bot.
  const requiredGroup = settingsInGroup(REQUIRED_GROUP);
  const toAsk =
    mode === 'first-run'
      ? requiredGroup.filter((setting) => {
          const value = current[setting.key];
          return value === undefined || value === '';
        })
      : requiredGroup;

  let finished = false;
  for (const setting of toAsk) {
    const outcome = await askSetting(io, setting, current[setting.key]);
    if (outcome.kind === 'abort') return { values: new Map(), aborted: true };
    if (outcome.kind === 'done' || outcome.kind === 'skip') {
      finished = true;
      break;
    }
    if (outcome.kind === 'value') record(setting, outcome.value);
  }

  if (finished) return { values, aborted: false };

  // In first-run mode the optional settings are one opt-in question, not two
  // dozen: the point of a first run is to get the bot up.
  if (mode === 'first-run') {
    const wantsMore = await askYesNo(
      io,
      '\nThat is everything required. Review the optional settings too? [y/N]',
      false,
    );
    if (!wantsMore) return { values, aborted: false };
  }

  for (const group of SETTING_GROUPS) {
    if (group === REQUIRED_GROUP) continue;
    const settings = settingsInGroup(group);
    if (settings.length === 0) continue;

    const gate = await askGroupGate(io, group, settings, current);
    if (gate === 'abort') return { values: new Map(), aborted: true };
    if (gate === 'done') return { values, aborted: false };
    if (gate === 'skip') continue;

    for (const setting of settings) {
      const outcome = await askSetting(io, setting, current[setting.key]);
      if (outcome.kind === 'abort') return { values: new Map(), aborted: true };
      if (outcome.kind === 'done') return { values, aborted: false };
      if (outcome.kind === 'skip') break;
      if (outcome.kind === 'value') record(setting, outcome.value);
    }
  }

  return { values, aborted: false };
}

/** Real-terminal adapter. Kept separate so nothing above touches stdin. */
export async function createTerminalIo(): Promise<WizardIo & { close: () => void }> {
  // Imported lazily so test runs never open a readline interface on stdin.
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
    write: (text: string) => process.stdout.write(`${text}\n`),
    close: () => rl.close(),
  };
}
