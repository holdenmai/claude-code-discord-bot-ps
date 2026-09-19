import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyEnv,
  formatEnvValue,
  parseEnv,
  readEnvFile,
  renderEnvFile,
  renderExampleEnvFile,
  updateEnvContents,
  writeEnvFile,
} from '../../src/config/env-file.js';
import { SETTINGS } from '../../src/config/settings-schema.js';

const tempFiles: string[] = [];

function tempEnvFile(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-env-'));
  const file = path.join(dir, '.env');
  if (contents !== undefined) fs.writeFileSync(file, contents, 'utf8');
  tempFiles.push(dir);
  return file;
}

afterEach(() => {
  while (tempFiles.length > 0) {
    const dir = tempFiles.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseEnv', () => {
  it('reads plain assignments', () => {
    expect(parseEnv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('ignores blank lines and comments', () => {
    expect(parseEnv('# nope\n\n#A=1\nB=2')).toEqual({ B: '2' });
  });

  it('accepts an export prefix and whitespace around =', () => {
    expect(parseEnv('export A = 1')).toEqual({ A: '1' });
  });

  it('strips inline comments from unquoted values', () => {
    expect(parseEnv('A=1 # trailing')).toEqual({ A: '1' });
  });

  it('keeps a # that is part of an unquoted value', () => {
    expect(parseEnv('A=c#1')).toEqual({ A: 'c#1' });
  });

  it('unwraps quotes and honours escapes inside double quotes', () => {
    expect(parseEnv('A="a b"\nB=\'c d\'\nC="x\\ny"')).toEqual({
      A: 'a b',
      B: 'c d',
      C: 'x\ny',
    });
  });

  it('does not unescape inside single quotes', () => {
    expect(parseEnv("A='x\\ny'")).toEqual({ A: 'x\\ny' });
  });

  it('lets the last assignment win, matching dotenv', () => {
    expect(parseEnv('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('reads an empty value as empty', () => {
    expect(parseEnv('A=')).toEqual({ A: '' });
  });
});

describe('formatEnvValue', () => {
  it('leaves simple values bare', () => {
    expect(formatEnvValue('claude-opus-5')).toBe('claude-opus-5');
    expect(formatEnvValue('/path/to/repos')).toBe('/path/to/repos');
  });

  it('leaves emoji bare, so reactions stay readable in the file', () => {
    expect(formatEnvValue('🤝')).toBe('🤝');
  });

  it('quotes values containing whitespace, quotes, or a comment character', () => {
    expect(formatEnvValue('a b')).toBe('"a b"');
    expect(formatEnvValue('C:\\repos')).toBe('"C:\\\\repos"');
    expect(formatEnvValue('say "hi"')).toBe('"say \\"hi\\""');
    expect(formatEnvValue('a # b')).toBe('"a # b"');
  });

  it('round-trips through the parser', () => {
    for (const value of ['a b', 'C:\\repos', 'say "hi"', '🤝', 'a # b', "it's"]) {
      expect(parseEnv(`K=${formatEnvValue(value)}`).K).toBe(value);
    }
  });
});

describe('applyEnv', () => {
  const snapshot = { ...process.env };

  afterEach(() => {
    process.env = { ...snapshot };
  });

  it('fills in values that are not already set', () => {
    delete process.env.TEST_APPLY_ENV;
    applyEnv({ TEST_APPLY_ENV: 'from-file' });
    expect(process.env.TEST_APPLY_ENV).toBe('from-file');
  });

  it('lets a real environment variable win over the file by default', () => {
    process.env.TEST_APPLY_ENV = 'from-shell';
    applyEnv({ TEST_APPLY_ENV: 'from-file' });
    expect(process.env.TEST_APPLY_ENV).toBe('from-shell');
  });

  it('overrides when asked, which is the post-wizard path', () => {
    process.env.TEST_APPLY_ENV = 'from-shell';
    applyEnv({ TEST_APPLY_ENV: 'from-wizard' }, { override: true });
    expect(process.env.TEST_APPLY_ENV).toBe('from-wizard');
  });

  it('treats an empty value as unset, not as an empty string', () => {
    process.env.TEST_APPLY_ENV = 'something';
    applyEnv({ TEST_APPLY_ENV: '' }, { override: true });
    expect(process.env.TEST_APPLY_ENV).toBeUndefined();
  });
});

describe('updateEnvContents', () => {
  it('rewrites a value in place, keeping the comment above it', () => {
    const before = '# your token\nDISCORD_TOKEN=old\n';
    const after = updateEnvContents(before, [['DISCORD_TOKEN', 'new']]);
    expect(after).toContain('# your token');
    expect(parseEnv(after).DISCORD_TOKEN).toBe('new');
  });

  it('preserves unrelated lines untouched', () => {
    const before = '# header\nA=1\n\n# keep me\nB=2\n';
    const after = updateEnvContents(before, [['A', '9']]);
    expect(after).toContain('# keep me');
    expect(parseEnv(after)).toEqual({ A: '9', B: '2' });
  });

  it('turns on a commented placeholder in its documented position', () => {
    const before = '# Default: 3001\n#MCP_SERVER_PORT=3001\n# later stuff\nA=1\n';
    const after = updateEnvContents(before, [['MCP_SERVER_PORT', '4000']]);
    const lines = after.split('\n');
    expect(lines[1]).toBe('MCP_SERVER_PORT=4000');
    expect(parseEnv(after).MCP_SERVER_PORT).toBe('4000');
  });

  it('comments a cleared value out rather than deleting its line', () => {
    const after = updateEnvContents('# doc\nA=1\n', [['A', null]]);
    expect(after).toContain('# doc');
    expect(after).toContain('#A=');
    expect(parseEnv(after).A).toBeUndefined();
  });

  it('does not append a key that was only asked to be cleared', () => {
    const after = updateEnvContents('B=2\n', [['A', null]]);
    expect(after).not.toContain('A=');
  });

  it('appends keys the file has never mentioned', () => {
    const after = updateEnvContents('A=1\n', [['LOG_MAX_MB', '512']]);
    expect(parseEnv(after)).toEqual({ A: '1', LOG_MAX_MB: '512' });
    expect(after).toContain('# Megabytes of log.txt kept before rotating');
  });

  it('rewrites every duplicate, so the last-wins parse cannot resurrect the old value', () => {
    const after = updateEnvContents('A=1\nB=2\nA=3\n', [['A', 'new']]);
    expect(parseEnv(after).A).toBe('new');
    expect(after).not.toContain('A=1');
    expect(after).not.toContain('A=3');
  });

  it('keeps CRLF line endings when the file already uses them', () => {
    const after = updateEnvContents('A=1\r\nB=2\r\n', [['A', '9']]);
    expect(after).toContain('\r\n');
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it('quotes a value that needs it', () => {
    const after = updateEnvContents('BASE_FOLDER=/x\n', [['BASE_FOLDER', 'C:\\my repos']]);
    expect(parseEnv(after).BASE_FOLDER).toBe('C:\\my repos');
  });
});

describe('renderEnvFile', () => {
  it('writes set values live and everything else commented out', () => {
    const rendered = renderEnvFile({ DISCORD_TOKEN: 'abc' });
    expect(parseEnv(rendered)).toEqual({ DISCORD_TOKEN: 'abc' });
    expect(rendered).toContain('#LOG_MAX_MB=256');
  });

  it('mentions every setting, so the file documents the whole surface', () => {
    const rendered = renderEnvFile({});
    for (const setting of SETTINGS) {
      expect(rendered).toContain(setting.key);
    }
  });

  it('groups settings under headers', () => {
    expect(renderEnvFile({})).toContain('# Connection');
  });
});

describe('writeEnvFile', () => {
  it('creates a documented file when none exists', () => {
    const file = tempEnvFile();
    const written = writeEnvFile(new Map([['DISCORD_TOKEN', 'abc']]), file);
    expect(written).toEqual({ DISCORD_TOKEN: 'abc' });
    expect(fs.readFileSync(file, 'utf8')).toContain('# Connection');
  });

  it('edits an existing file in place', () => {
    const file = tempEnvFile('# mine\nDISCORD_TOKEN=old\nCUSTOM=keep\n');
    writeEnvFile(new Map([['DISCORD_TOKEN', 'new']]), file);
    const contents = fs.readFileSync(file, 'utf8');
    expect(contents).toContain('# mine');
    expect(parseEnv(contents)).toEqual({ DISCORD_TOKEN: 'new', CUSTOM: 'keep' });
  });

  it('returns what is actually on disk', () => {
    const file = tempEnvFile('A=1\n');
    const written = writeEnvFile(new Map([['A', null]]), file);
    expect(written.A).toBeUndefined();
  });
});

describe('readEnvFile', () => {
  it('returns nothing rather than throwing when there is no file', () => {
    expect(readEnvFile(path.join(os.tmpdir(), 'definitely-not-here', '.env'))).toEqual({});
  });
});

describe('.env.example', () => {
  it('matches what the schema renders, so no setting goes undocumented', () => {
    const onDisk = fs.readFileSync(
      path.join(process.cwd(), '.env.example'),
      'utf8',
    );
    expect(onDisk.replace(/\r\n/g, '\n')).toBe(renderExampleEnvFile());
  });

  it('ships the required settings as live placeholder lines', () => {
    const parsed = parseEnv(renderExampleEnvFile());
    expect(Object.keys(parsed).sort()).toEqual([
      'ALLOWED_USER_ID',
      'BASE_FOLDER',
      'DISCORD_TOKEN',
    ]);
  });
});
