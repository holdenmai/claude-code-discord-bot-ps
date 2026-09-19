import { describe, it, expect } from 'vitest';
import { describeCurrent, runWizard, wrap } from '../../src/config/wizard.js';
import type { WizardIo } from '../../src/config/wizard.js';
import { SETTINGS_BY_KEY } from '../../src/config/settings-schema.js';
import type { Setting } from '../../src/config/settings-schema.js';

function setting(key: string): Setting {
  const found = SETTINGS_BY_KEY.get(key);
  if (!found) throw new Error(`no such setting: ${key}`);
  return found;
}

/**
 * A scripted terminal. Answers are consumed in order; running out is a test
 * bug (an unexpected extra question), so it throws rather than hanging.
 */
function scriptedIo(answers: string[]): WizardIo & { output: string[]; remaining: () => number } {
  const queue = [...answers];
  const output: string[] = [];
  return {
    output,
    remaining: () => queue.length,
    ask: async (prompt: string) => {
      output.push(prompt);
      if (queue.length === 0) throw new Error(`wizard asked more than expected:\n${output.join('\n')}`);
      return queue.shift() as string;
    },
    write: (text: string) => {
      output.push(text);
    },
  };
}

const REQUIRED_ANSWERS = ['aaa.bbb.ccc', '123456789012345678', '/tmp/repos'];

describe('describeCurrent', () => {
  it('offers to keep a value that is already set', () => {
    expect(describeCurrent(setting('BASE_FOLDER'), '/repos')).toBe('keep /repos');
  });

  it('masks a secret it offers to keep', () => {
    expect(describeCurrent(setting('DISCORD_TOKEN'), 'abcdefghijklmnop')).toBe('keep abcd...mnop');
  });

  it('names the default for an unset optional setting', () => {
    expect(describeCurrent(setting('LOG_MAX_MB'), undefined)).toBe('default 256');
  });

  it('says required, with an example, when there is nothing to fall back on', () => {
    expect(describeCurrent(setting('DISCORD_TOKEN'), undefined)).toContain('required, e.g.');
  });

  it('says off for an optional setting with no default', () => {
    expect(describeCurrent(setting('BOT_INSTANCE_ID'), undefined)).toContain('off');
  });
});

describe('wrap', () => {
  it('breaks long prose at the requested width', () => {
    const wrapped = wrap('a '.repeat(80).trim(), 20, '');
    for (const line of wrapped.split('\n')) expect(line.length).toBeLessThanOrEqual(20);
  });
});

describe('runWizard — first run', () => {
  it('asks only for what is missing, then offers the optional settings', () => {
    return runWizard({
      mode: 'first-run',
      current: { DISCORD_TOKEN: 'already.set.here' },
      io: scriptedIo(['123456789012345678', '/tmp/repos', 'n']),
    }).then((result) => {
      expect(result.aborted).toBe(false);
      expect([...result.values.keys()]).toEqual(['ALLOWED_USER_ID', 'BASE_FOLDER']);
    });
  });

  it('declining the optional review ends the wizard', async () => {
    const io = scriptedIo([...REQUIRED_ANSWERS, 'n']);
    await runWizard({ mode: 'first-run', current: {}, io });
    expect(io.remaining()).toBe(0);
  });

  it('records only what changed, never the untouched settings', async () => {
    const result = await runWizard({
      mode: 'first-run',
      current: {},
      io: scriptedIo([...REQUIRED_ANSWERS, 'n']),
    });
    expect([...result.values.keys()]).toEqual(['DISCORD_TOKEN', 'ALLOWED_USER_ID', 'BASE_FOLDER']);
    expect(result.values.get('BASE_FOLDER')).toBe('/tmp/repos');
  });

  it('will not accept Enter on a required setting that has no current value', async () => {
    const io = scriptedIo(['', 'aaa.bbb.ccc', '123456789012345678', '/tmp/repos', 'n']);
    const result = await runWizard({ mode: 'first-run', current: {}, io });
    expect(io.output.join('\n')).toContain('DISCORD_TOKEN is required');
    expect(result.values.get('DISCORD_TOKEN')).toBe('aaa.bbb.ccc');
  });
});

describe('runWizard — answering', () => {
  it('re-asks after a rejected value and keeps the explanation', async () => {
    const io = scriptedIo(['aaa.bbb.ccc', 'not-a-number', '123456789012345678', '/tmp/repos', 'n']);
    const result = await runWizard({ mode: 'first-run', current: {}, io });
    expect(io.output.join('\n')).toContain('digits only');
    expect(result.values.get('ALLOWED_USER_ID')).toBe('123456789012345678');
  });

  it('prints the long help on -help and asks again', async () => {
    const io = scriptedIo(['-help', 'aaa.bbb.ccc', '123456789012345678', '/tmp/repos', 'n']);
    await runWizard({ mode: 'first-run', current: {}, io });
    const printed = io.output.join('\n');
    expect(printed).toContain('Discord Developer Portal');
    expect(printed).toContain('Stored in .env as DISCORD_TOKEN.');
  });

  it('accepts --help and help as the same request', async () => {
    const io = scriptedIo(['--help', 'aaa.bbb.ccc', '123456789012345678', '/tmp/repos', 'n']);
    await runWizard({ mode: 'first-run', current: {}, io });
    expect(io.output.join('\n')).toContain('Discord Developer Portal');
  });

  it('accepts a value but surfaces a warning about it', async () => {
    const io = scriptedIo(['aaa.bbb.ccc', '12345', '/tmp/repos', 'n']);
    const result = await runWizard({ mode: 'first-run', current: {}, io });
    expect(io.output.join('\n')).toContain('Note:');
    expect(result.values.get('ALLOWED_USER_ID')).toBe('12345');
  });

  it('refuses to clear a required setting', async () => {
    const io = scriptedIo(['-clear', 'aaa.bbb.ccc', '123456789012345678', '/tmp/repos', 'n']);
    await runWizard({ mode: 'first-run', current: {}, io });
    expect(io.output.join('\n')).toContain("can't be cleared");
  });
});

describe('runWizard — full pass', () => {
  const current = {
    DISCORD_TOKEN: 'aaa.bbb.ccc',
    ALLOWED_USER_ID: '123456789012345678',
    BASE_FOLDER: '/tmp/repos',
  };

  it('keeps everything when the user just presses Enter through it', async () => {
    // Three required Enters, then "no" at each optional group gate.
    const answers = ['', '', '', 'n', 'n', 'n', 'n', 'n', 'n'];
    const result = await runWizard({ mode: 'full', current, io: scriptedIo(answers) });
    expect(result.values.size).toBe(0);
    expect(result.aborted).toBe(false);
  });

  it('shows a group summary before asking whether to change it', async () => {
    const io = scriptedIo(['', '', '', 'n', 'n', 'n', 'n', 'n', 'n']);
    await runWizard({ mode: 'full', current, io });
    const printed = io.output.join('\n');
    expect(printed).toContain('── Models');
    expect(printed).toContain('DEFAULT_MODEL = claude-opus-5 (default)');
  });

  it('enters a group when the gate is accepted', async () => {
    const io = scriptedIo(['', '', '', 'y', 'claude-sonnet-5', '', '-done']);
    const result = await runWizard({ mode: 'full', current, io });
    expect(result.values.get('DEFAULT_MODEL')).toBe('claude-sonnet-5');
    expect(result.values.has('LEGACY_SESSION_MODEL')).toBe(false);
  });

  it('-skip inside a group leaves the rest of it alone', async () => {
    const io = scriptedIo(['', '', '', 'y', 'claude-sonnet-5', '-skip', 'n', 'n', 'n', 'n', 'n']);
    const result = await runWizard({ mode: 'full', current, io });
    expect(result.values.get('DEFAULT_MODEL')).toBe('claude-sonnet-5');
    expect(result.values.has('LEGACY_SESSION_MODEL')).toBe(false);
  });

  it('-done stops asking but keeps what was answered', async () => {
    const io = scriptedIo(['', '', '', 'y', 'claude-sonnet-5', '-done']);
    const result = await runWizard({ mode: 'full', current, io });
    expect(result.aborted).toBe(false);
    expect(result.values.get('DEFAULT_MODEL')).toBe('claude-sonnet-5');
    expect(io.remaining()).toBe(0);
  });

  it('-abort throws away everything, including earlier answers', async () => {
    const io = scriptedIo(['', '', '', 'y', 'claude-sonnet-5', '-abort']);
    const result = await runWizard({ mode: 'full', current, io });
    expect(result.aborted).toBe(true);
    expect(result.values.size).toBe(0);
  });

  it('clears an optional setting back to its default', async () => {
    const io = scriptedIo(['', '', '', 'n', 'n', 'n', 'n', 'n', 'y', '-clear']);
    const result = await runWizard({
      mode: 'full',
      current: { ...current, LOG_MAX_MB: '1024' },
      io,
    });
    expect(result.values.get('LOG_MAX_MB')).toBeNull();
  });

  it('explains a whole group on -help at the gate', async () => {
    const io = scriptedIo(['', '', '', '-help', 'n', 'n', 'n', 'n', 'n', 'n']);
    await runWizard({ mode: 'full', current, io });
    expect(io.output.join('\n')).toContain('a tier alias (opus)');
  });

  it('insists on y or n at a gate', async () => {
    const io = scriptedIo(['', '', '', 'maybe', 'n', 'n', 'n', 'n', 'n', 'n']);
    await runWizard({ mode: 'full', current, io });
    expect(io.output.join('\n')).toContain('Please answer y or n.');
  });

  it('shows a later question the answer given to an earlier one', async () => {
    // BOT_PRIORITY's summary should reflect a BOT_INSTANCE_ID typed moments ago
    // rather than the value the wizard started with.
    const io = scriptedIo(['', '', '', 'n', 'n', 'n', 'n', 'y', 'windows', '-done']);
    const result = await runWizard({ mode: 'full', current, io });
    expect(result.values.get('BOT_INSTANCE_ID')).toBe('windows');
  });

  it('never prints a secret in full', async () => {
    const io = scriptedIo(['', '', '', 'n', 'n', 'n', 'n', 'n', 'n']);
    await runWizard({
      mode: 'full',
      current: { ...current, DISCORD_TOKEN: 'supersecrettokenvalue' },
      io,
    });
    expect(io.output.join('\n')).not.toContain('supersecrettokenvalue');
  });
});
