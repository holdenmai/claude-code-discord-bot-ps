import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bootstrap } from '../../src/config/bootstrap.js';
import { parseEnv } from '../../src/config/env-file.js';
import type { WizardIo } from '../../src/config/wizard.js';

const REQUIRED = ['DISCORD_TOKEN', 'ALLOWED_USER_ID', 'BASE_FOLDER'] as const;

let dir: string;
let file: string;
let logs: string[];
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv };
  for (const key of REQUIRED) delete process.env[key];
  delete process.env.LOG_MAX_MB;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-boot-'));
  file = path.join(dir, '.env');
  logs = [];
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

function io(answers: string[]): () => Promise<WizardIo & { close: () => void }> {
  const queue = [...answers];
  return async () => ({
    ask: async () => {
      if (queue.length === 0) throw new Error('wizard asked more than expected');
      return queue.shift() as string;
    },
    write: (text: string) => logs.push(text),
    close: () => {},
  });
}

function run(options: {
  argv?: string[];
  answers?: string[];
  interactive?: boolean;
}) {
  return bootstrap({
    argv: options.argv ?? [],
    envFile: file,
    isInteractive: () => options.interactive ?? true,
    log: (message) => logs.push(message),
    createIo: io(options.answers ?? []),
  });
}

const GOOD_ANSWERS = ['aaa.bbb.ccc', '123456789012345678', os.tmpdir(), 'n'];

describe('bootstrap — no wizard needed', () => {
  it('starts straight away when .env is complete', async () => {
    fs.writeFileSync(file, 'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\n');
    const outcome = await run({});
    expect(outcome).toEqual({ shouldStart: true, exitCode: 0 });
    expect(process.env.DISCORD_TOKEN).toBe('t');
  });

  it('lets a real environment variable beat the file', async () => {
    fs.writeFileSync(file, 'DISCORD_TOKEN=from-file\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\n');
    process.env.DISCORD_TOKEN = 'from-shell';
    await run({});
    expect(process.env.DISCORD_TOKEN).toBe('from-shell');
  });

  it('starts with no file at all when the environment already has everything', async () => {
    process.env.DISCORD_TOKEN = 't';
    process.env.ALLOWED_USER_ID = '1';
    process.env.BASE_FOLDER = '/x';
    expect(await run({})).toEqual({ shouldStart: true, exitCode: 0 });
  });
});

describe('bootstrap — first run', () => {
  it('runs the wizard when a required setting is missing, then starts', async () => {
    const outcome = await run({ answers: GOOD_ANSWERS });
    expect(outcome).toEqual({ shouldStart: true, exitCode: 0 });
    expect(parseEnv(fs.readFileSync(file, 'utf8')).DISCORD_TOKEN).toBe('aaa.bbb.ccc');
  });

  it('makes the answers visible to the code that reads process.env', async () => {
    await run({ answers: GOOD_ANSWERS });
    expect(process.env.DISCORD_TOKEN).toBe('aaa.bbb.ccc');
    expect(process.env.ALLOWED_USER_ID).toBe('123456789012345678');
  });

  it('asks only for the one setting that is missing', async () => {
    fs.writeFileSync(file, 'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\n');
    const outcome = await run({ answers: [os.tmpdir(), 'n'] });
    expect(outcome.shouldStart).toBe(true);
    expect(parseEnv(fs.readFileSync(file, 'utf8')).BASE_FOLDER).toBe(os.tmpdir());
  });

  it('keeps the rest of an existing .env when it writes', async () => {
    fs.writeFileSync(file, '# my notes\nDISCORD_TOKEN=t\nALLOWED_USER_ID=1\nCUSTOM=keep\n');
    await run({ answers: [os.tmpdir(), 'n'] });
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).toContain('# my notes');
    expect(parseEnv(contents).CUSTOM).toBe('keep');
  });

  it('refuses to start when the user aborts with things still missing', async () => {
    const outcome = await run({ answers: ['-abort'] });
    expect(outcome).toEqual({ shouldStart: false, exitCode: 1 });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('bootstrap — non-interactive', () => {
  it('reports what is missing instead of blocking on a prompt', async () => {
    const outcome = await run({ interactive: false });
    expect(outcome).toEqual({ shouldStart: false, exitCode: 1 });
    expect(logs.join('\n')).toContain('Missing required configuration');
    expect(logs.join('\n')).toContain('bun run config');
  });

  it('explains why -config cannot run without a terminal', async () => {
    fs.writeFileSync(file, 'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\n');
    const outcome = await run({ argv: ['-config'], interactive: false });
    expect(outcome).toEqual({ shouldStart: false, exitCode: 1 });
    expect(logs.join('\n')).toContain('not interactive');
  });
});

describe('bootstrap — flags', () => {
  it('-config walks the full wizard on an already-configured bot, then starts', async () => {
    fs.writeFileSync(file, 'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\n');
    const answers = ['', '', '', 'y', 'claude-sonnet-5', '-done'];
    const outcome = await run({ argv: ['-config'], answers });
    expect(outcome).toEqual({ shouldStart: true, exitCode: 0 });
    expect(parseEnv(fs.readFileSync(file, 'utf8')).DEFAULT_MODEL).toBe('claude-sonnet-5');
    expect(process.env.DEFAULT_MODEL).toBe('claude-sonnet-5');
  });

  it('-configonly saves and stops without starting the bot', async () => {
    // -configonly implies the full pass, so the three required answers are
    // followed by a gate per optional group rather than one "review?" question.
    const answers = ['aaa.bbb.ccc', '123456789012345678', os.tmpdir(), '-done'];
    const outcome = await run({ argv: ['-configonly'], answers });
    expect(outcome).toEqual({ shouldStart: false, exitCode: 0 });
    expect(parseEnv(fs.readFileSync(file, 'utf8')).DISCORD_TOKEN).toBe('aaa.bbb.ccc');
    expect(logs.join('\n')).toContain('bun run start');
  });

  it('-help prints usage and stops cleanly', async () => {
    const outcome = await run({ argv: ['-help'] });
    expect(outcome).toEqual({ shouldStart: false, exitCode: 0 });
    expect(logs.join('\n')).toContain('Usage:');
  });

  it('rejects an unknown flag rather than starting anyway', async () => {
    const outcome = await run({ argv: ['--wat'] });
    expect(outcome).toEqual({ shouldStart: false, exitCode: 1 });
    expect(logs.join('\n')).toContain('Unknown option');
  });

  it('removes a cleared setting from the running environment', async () => {
    fs.writeFileSync(
      file,
      'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\nLOG_MAX_MB=1024\n',
    );
    // Enter past the required three, decline every group but Logging, clear it.
    const answers = ['', '', '', 'n', 'n', 'n', 'n', 'n', 'y', '-clear'];
    await run({ argv: ['-config'], answers });
    expect(process.env.LOG_MAX_MB).toBeUndefined();
    expect(parseEnv(fs.readFileSync(file, 'utf8')).LOG_MAX_MB).toBeUndefined();
  });

  it('shows a setting at its live value, not the shadowed one from the file', async () => {
    fs.writeFileSync(
      file,
      'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\nLOG_MAX_MB=111\n',
    );
    process.env.LOG_MAX_MB = '999';
    await run({ argv: ['-config'], answers: ['', '', '', 'n', 'n', 'n', 'n', 'n', 'n'] });
    expect(logs.join('\n')).toContain('LOG_MAX_MB = 999');
    expect(logs.join('\n')).not.toContain('LOG_MAX_MB = 111');
  });

  it('writes nothing when a full pass changes nothing', async () => {
    const before = 'DISCORD_TOKEN=t\nALLOWED_USER_ID=1\nBASE_FOLDER=/x\n';
    fs.writeFileSync(file, before);
    await run({ argv: ['-config'], answers: ['', '', '', 'n', 'n', 'n', 'n', 'n', 'n'] });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(logs.join('\n')).toContain('No changes.');
  });
});
