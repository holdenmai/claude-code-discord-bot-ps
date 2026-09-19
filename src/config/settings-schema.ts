import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Every setting the bot reads out of the environment, in one place.
 *
 * This file is the single source of truth for configuration: the interactive
 * wizard walks it, `.env` is generated from it, and a test asserts `.env.example`
 * still matches it. Adding a `process.env.X` read anywhere in `src/` without
 * adding it here means it can't be configured without hand-editing `.env`,
 * which is the thing this exists to avoid.
 */

export type SettingKind =
  | 'string'
  | 'secret'
  | 'path'
  | 'integer'
  | 'boolean'
  | 'choice';

export interface Setting {
  key: string;
  group: SettingGroup;
  /** One short line. This is what the user sees at the prompt. */
  label: string;
  /** The long version, printed only when they answer `-help`. */
  help: string;
  kind: SettingKind;
  /** Required settings can't be cleared and block startup when missing. */
  required?: boolean;
  /** The value the code falls back to when this is unset. Shown as `[default X]`. */
  default?: string;
  /** Shown instead of a default for required settings, as `e.g. …`. */
  example?: string;
  choices?: readonly string[];
  min?: number;
  max?: number;
  /** Cleanup applied to accepted input (trimming `~`, quotes, and so on). */
  normalize?: (value: string) => string;
  /** Hard failure: the value is rejected and the question is asked again. */
  validate?: (value: string) => string | undefined;
  /** Soft failure: the value is accepted, but the user is told why it looks off. */
  warn?: (value: string) => string | undefined;
}

export const SETTING_GROUPS = [
  'Connection',
  'Models',
  'Tool approvals',
  'Timeouts',
  'Discord presentation',
  'Multi-instance',
  'Logging',
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** The group the bot cannot start without. Always asked, never gated. */
export const REQUIRED_GROUP: SettingGroup = 'Connection';

// Deliberately not platform-branched: this string is written into the
// checked-in .env.example, which has to read the same on every machine.
const HOME_EXAMPLE = '/path/to/your/repos';

/** `~/repos` is what people type; it is not a path anything else understands. */
function expandHome(value: string): string {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function trimQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

export const SETTINGS: readonly Setting[] = [
  // ── Connection ────────────────────────────────────────────────────────────
  {
    key: 'DISCORD_TOKEN',
    group: 'Connection',
    label: 'Discord bot token',
    help:
      "The bot token from the Discord Developer Portal (Applications -> your app -> Bot -> Reset Token). " +
      "It is a password: anyone holding it can act as your bot. It is stored in plain text in .env, " +
      "which this repo's .gitignore already excludes -- keep it that way.",
    kind: 'secret',
    required: true,
    // Shaped like a real token (three dot-separated parts) but deliberately
    // broken with angle brackets: a convincing placeholder trips GitHub's
    // secret scanner and blocks the push.
    example: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.<the-rest-of-your-token>',
    normalize: trimQuotes,
    warn: (value) =>
      /^your_|_here$/i.test(value)
        ? 'That looks like the placeholder from .env.example, not a real token.'
        : value.split('.').length < 3
          ? 'Discord tokens normally have three dot-separated parts. Double-check you copied the whole thing.'
          : undefined,
  },
  {
    key: 'ALLOWED_USER_ID',
    group: 'Connection',
    label: 'Your Discord user ID (the only account the bot answers)',
    help:
      'The numeric ID of the single Discord account allowed to talk to the bot; messages from anyone else ' +
      'are ignored. To find it, turn on Settings -> Advanced -> Developer Mode in Discord, then right-click ' +
      "your own name and pick 'Copy User ID'. It is 17-20 digits -- not your username.",
    kind: 'string',
    required: true,
    example: '123456789012345678',
    normalize: trimQuotes,
    validate: (value) =>
      /^\d+$/.test(value)
        ? undefined
        : 'A user ID is digits only. Turn on Developer Mode in Discord and use "Copy User ID".',
    warn: (value) =>
      value.length < 17 || value.length > 20
        ? 'Discord user IDs are usually 17-20 digits; this one is ' + value.length + '.'
        : undefined,
  },
  {
    key: 'BASE_FOLDER',
    group: 'Connection',
    label: 'Folder that holds your repositories',
    help:
      'Every Discord channel maps to a subfolder of this path: channel #my-project runs Claude Code in ' +
      '<BASE_FOLDER>/my-project. Point it at the directory your repos already live in -- the bot reads ' +
      'the folder to offer projects in /add, and never creates it for you. Windows paths work as-is ' +
      '(C:\\repos), and a leading ~ is expanded.',
    kind: 'path',
    required: true,
    example: HOME_EXAMPLE,
    normalize: expandHome,
    warn: (value) => {
      try {
        if (!fs.existsSync(value)) return "That folder doesn't exist yet. Saved anyway -- create it before running.";
        if (!fs.statSync(value).isDirectory()) return 'That path exists but is a file, not a folder.';
      } catch {
        return 'Could not check that path. Saved anyway.';
      }
      return undefined;
    },
  },

  // ── Models ────────────────────────────────────────────────────────────────
  {
    key: 'DEFAULT_MODEL',
    group: 'Models',
    label: 'Model new sessions start on',
    help:
      'The model a channel uses when it starts a brand-new session. A session pins whatever model it began ' +
      'with and keeps it for life, so changing this never moves a conversation already in flight -- use ' +
      '/model in the channel for that. Takes a full model id (claude-opus-5) or a tier alias (opus), ' +
      'though an alias drifts as the CLI repoints that tier.',
    kind: 'string',
    default: 'claude-opus-5',
    normalize: trimQuotes,
  },
  {
    key: 'LEGACY_SESSION_MODEL',
    group: 'Models',
    label: 'Model for sessions created before model pinning existed',
    help:
      'Sessions recorded before the bot started pinning models have no model of their own. Rather than ' +
      'silently moving them onto today\'s default, they run on this. If you are setting the bot up for the ' +
      'first time, it never comes up.',
    kind: 'string',
    default: 'claude-opus-4-8',
    normalize: trimQuotes,
  },

  // ── Tool approvals ────────────────────────────────────────────────────────
  {
    key: 'MCP_SERVER_PORT',
    group: 'Tool approvals',
    label: 'Local port for the tool-approval server',
    help:
      'The bot runs a small local MCP server that the Claude CLI calls into whenever it wants approval for ' +
      'a tool. Nothing outside this machine needs to reach it, so change the port only if something else ' +
      'already owns 3001. Two bot instances on one machine need different ports.',
    kind: 'integer',
    default: '3001',
    min: 1,
    max: 65535,
  },
  {
    key: 'MCP_APPROVAL_TIMEOUT',
    group: 'Tool approvals',
    label: 'Seconds to wait for you to approve a tool',
    help:
      'How long an approval request sits in Discord before it gives up and applies MCP_DEFAULT_ON_TIMEOUT. ' +
      'Raise it if you are often away from the keyboard when the bot asks.',
    kind: 'integer',
    default: '30',
    min: 1,
    max: 86400,
  },
  {
    key: 'MCP_DEFAULT_ON_TIMEOUT',
    group: 'Tool approvals',
    label: 'What an unanswered approval does when it times out',
    help:
      "'deny' blocks the tool -- Claude is told no and carries on, which is the safe default. 'allow' lets " +
      'it run unattended, so the bot keeps working while you are away. Pick allow only if you trust every ' +
      'project folder the bot can reach.',
    kind: 'choice',
    choices: ['deny', 'allow'],
    default: 'deny',
  },

  // ── Timeouts ──────────────────────────────────────────────────────────────
  {
    key: 'SESSION_IDLE_SECONDS',
    group: 'Timeouts',
    label: 'Seconds an idle CLI process is kept alive',
    help:
      "A channel's Claude CLI process outlives the turn that spawned it, so the next prompt is injected " +
      'into the running session instead of paying for a --resume. This is how long it is kept around with ' +
      'nothing to do. Longer means faster follow-ups and more idle processes.',
    kind: 'integer',
    default: '600',
    min: 0,
  },
  {
    key: 'TURN_INACTIVITY_SECONDS',
    group: 'Timeouts',
    label: "Seconds of silence within a turn before it's treated as hung",
    help:
      'Only applies while a turn is actually in flight -- an idle process is supposed to be quiet. A turn ' +
      'that produces nothing for this long is killed. Anything legitimately being waited on (a live ' +
      'background task, or an unanswered question or tool approval) re-arms the window instead. Raise it ' +
      "if you run long foreground builds near the CLI's own 600-second Bash cap.",
    kind: 'integer',
    default: '600',
    min: 1,
  },
  {
    key: 'WATCHER_MAX_HOLD_SECONDS',
    group: 'Timeouts',
    label: 'Ceiling on holding a process open for background tasks',
    help:
      'Live background tasks (Monitor, background shells) hold their CLI process open past the idle ' +
      'timeout, because killing the process kills the watcher. This is the absolute cap on that, so a ' +
      "watcher that never finishes can't pin a process and its MCP bridge open forever. Default is 6 hours.",
    kind: 'integer',
    default: '21600',
    min: 0,
  },
  {
    key: 'QUESTION_WATCHDOG_SECONDS',
    group: 'Timeouts',
    label: 'Seconds of silence allowed after you answer a question',
    help:
      'Once your AskUserQuestion answers reach the CLI the turn should start moving again. If it stays ' +
      'silent this long, the turn is treated as wedged on its own question and recovered.',
    kind: 'integer',
    default: '120',
    min: 1,
  },
  {
    key: 'AUTOPAUSE_TIMEOUT_SECONDS',
    group: 'Timeouts',
    label: 'Seconds /autopause waits for Claude to name the session',
    help:
      '/autopause parks the session immediately, then asks Claude in a separate one-shot run for a name to ' +
      'file it under. This is how long that run gets. On a timeout the session stays parked under its ' +
      'session id, where /resume <id> still finds it -- nothing is lost, it just has no friendly name.',
    kind: 'integer',
    default: '180',
    min: 1,
  },

  // ── Discord presentation ──────────────────────────────────────────────────
  {
    key: 'ENABLE_REACTIONS',
    group: 'Discord presentation',
    label: 'React to your prompt messages with progress emoji',
    help:
      'When on, the bot adds an emoji to your message as it works and swaps it when the turn ends, so a ' +
      "channel's history shows at a glance which prompts succeeded. The four emoji are configurable below.",
    kind: 'boolean',
    default: 'false',
  },
  {
    key: 'REACTION_PROCESSING',
    group: 'Discord presentation',
    label: 'Emoji while a turn is running',
    help:
      'Added to your message as soon as the turn starts. Use an actual emoji character, not the ' +
      ':shortcode: form Discord shows you when typing. Only used when reactions are enabled.',
    kind: 'string',
    default: '🤝',
  },
  {
    key: 'REACTION_SUCCESS',
    group: 'Discord presentation',
    label: 'Emoji when a turn finishes cleanly',
    help: 'Replaces the processing emoji once the turn completes without errors.',
    kind: 'string',
    default: '👍',
  },
  {
    key: 'REACTION_PARTIAL',
    group: 'Discord presentation',
    label: 'Emoji when a turn ends early',
    help: 'Used when the turn ended but not cleanly -- interrupted with /stop, or stopped part-way.',
    kind: 'string',
    default: '🤞',
  },
  {
    key: 'REACTION_FAILED',
    group: 'Discord presentation',
    label: 'Emoji when a turn errors out',
    help: 'Used when the turn failed outright.',
    kind: 'string',
    default: '👎',
  },
  {
    key: 'PROMPT_LINK_STYLE',
    group: 'Discord presentation',
    label: "How the 'jump to prompt' link appears when a turn finishes",
    help:
      'The completion message can link back to the message that started the turn, which is worth having in ' +
      "a busy channel. 'link' posts the bare URL and lets Discord unfurl it, 'plaintext' a labelled line, " +
      "'embed' a field inside the completion embed, 'none' turns it off.",
    kind: 'choice',
    choices: ['link', 'plaintext', 'embed', 'none'],
    default: 'link',
  },
  {
    key: 'ACTIVITY_LINKS',
    group: 'Discord presentation',
    label: "Post activity links to the home category's #general",
    help:
      "When on, each turn also drops a link in the 'general' channel of your home category (and in a " +
      "thread's parent channel), so one place shows everything happening across every project.",
    kind: 'boolean',
    default: 'false',
  },
  {
    key: 'ACTIVITY_LINK_STYLE',
    group: 'Discord presentation',
    label: 'How those activity links are posted',
    help: "Only used when activity links are on. 'link' posts the bare URL, the others add context around it.",
    kind: 'choice',
    choices: ['plaintext', 'embed', 'link'],
    default: 'plaintext',
  },

  // ── Multi-instance ────────────────────────────────────────────────────────
  {
    key: 'BOT_INSTANCE_ID',
    group: 'Multi-instance',
    label: 'Name for this machine when running several bots',
    help:
      'Only needed if you run the bot on more than one machine against the same Discord server. Give each ' +
      'one a name (linux, windows) and they coordinate so exactly one handles each channel. Leave it empty ' +
      'for a single-machine setup -- that switches multi-instance routing off entirely.',
    kind: 'string',
    example: 'windows',
    normalize: trimQuotes,
  },
  {
    key: 'BOT_PRIORITY',
    group: 'Multi-instance',
    label: 'Priority of this instance (1 = highest)',
    help:
      'Only used when this machine has a name set above. The lowest number wins; higher-numbered instances ' +
      'wait before picking up work, so they act as fallbacks. Ignored entirely for a single-machine setup.',
    kind: 'integer',
    default: '1',
    min: 1,
  },

  // ── Logging ───────────────────────────────────────────────────────────────
  {
    key: 'LOG_MAX_MB',
    group: 'Logging',
    label: 'Megabytes of log.txt kept before rotating',
    help:
      'log.txt is rotated once it passes this size, keeping exactly one previous generation as log.txt.1. ' +
      'Everything the bot and the CLI print goes there, so a busy bot fills it quickly.',
    kind: 'integer',
    default: '256',
    min: 1,
  },
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, Setting> = new Map(
  SETTINGS.map((setting) => [setting.key, setting]),
);

export function settingsInGroup(group: SettingGroup): Setting[] {
  return SETTINGS.filter((setting) => setting.group === group);
}

export function requiredSettings(): Setting[] {
  return SETTINGS.filter((setting) => setting.required);
}

export type ValidationResult =
  | { ok: true; value: string; warning?: string }
  | { ok: false; error: string };

const TRUTHY = new Set(['true', 'yes', 'y', 'on', '1']);
const FALSY = new Set(['false', 'no', 'n', 'off', '0']);

/**
 * Turn raw typed input into the string that belongs in `.env`, or explain why
 * it can't be. Pure, so the wizard's whole validation surface is unit-testable
 * without a terminal.
 */
export function validateSetting(setting: Setting, raw: string): ValidationResult {
  const normalized = (setting.normalize ?? ((v: string) => v.trim()))(raw);

  if (normalized === '') {
    if (setting.required) return { ok: false, error: `${setting.key} is required.` };
    return { ok: true, value: '' };
  }

  switch (setting.kind) {
    case 'integer': {
      if (!/^-?\d+$/.test(normalized)) {
        return { ok: false, error: `${setting.key} must be a whole number.` };
      }
      const parsed = Number(normalized);
      if (setting.min !== undefined && parsed < setting.min) {
        return { ok: false, error: `${setting.key} must be at least ${setting.min}.` };
      }
      if (setting.max !== undefined && parsed > setting.max) {
        return { ok: false, error: `${setting.key} must be at most ${setting.max}.` };
      }
      break;
    }
    case 'boolean': {
      const lowered = normalized.toLowerCase();
      if (TRUTHY.has(lowered)) return { ok: true, value: 'true' };
      if (FALSY.has(lowered)) return { ok: true, value: 'false' };
      return { ok: false, error: `${setting.key} is yes or no.` };
    }
    case 'choice': {
      const lowered = normalized.toLowerCase();
      const match = setting.choices?.find((choice) => choice.toLowerCase() === lowered);
      if (!match) {
        return { ok: false, error: `${setting.key} is one of: ${(setting.choices ?? []).join(', ')}.` };
      }
      return { ok: true, value: match };
    }
    default:
      break;
  }

  const error = setting.validate?.(normalized);
  if (error) return { ok: false, error };

  return { ok: true, value: normalized, warning: setting.warn?.(normalized) };
}

/** Tokens are shown back to the user, so never in full. */
export function maskValue(setting: Setting, value: string): string {
  if (setting.kind !== 'secret' || value.length === 0) return value;
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
