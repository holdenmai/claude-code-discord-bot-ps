import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  REQUIRED_GROUP,
  SETTINGS,
  SETTINGS_BY_KEY,
  SETTING_GROUPS,
  maskValue,
  requiredSettings,
  settingsInGroup,
  validateSetting,
} from '../../src/config/settings-schema.js';
import type { Setting } from '../../src/config/settings-schema.js';

function setting(key: string): Setting {
  const found = SETTINGS_BY_KEY.get(key);
  if (!found) throw new Error(`no such setting: ${key}`);
  return found;
}

describe('the schema itself', () => {
  it('has no duplicate keys', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only uses declared groups', () => {
    for (const s of SETTINGS) {
      expect(SETTING_GROUPS).toContain(s.group);
    }
  });

  it('gives every setting a label and help text', () => {
    for (const s of SETTINGS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.help.length).toBeGreaterThan(20);
    }
  });

  it('gives every optional setting either a default or an example', () => {
    for (const s of SETTINGS) {
      if (s.required) continue;
      expect(s.default ?? s.example).toBeDefined();
    }
  });

  it('keeps every required setting in the group the wizard always asks', () => {
    for (const s of requiredSettings()) {
      expect(s.group).toBe(REQUIRED_GROUP);
    }
  });

  it('gives choice settings a default that is one of their choices', () => {
    for (const s of SETTINGS) {
      if (!s.choices || s.default === undefined) continue;
      expect(s.choices).toContain(s.default);
    }
  });

  it('gives every default a value its own validation accepts', () => {
    for (const s of SETTINGS) {
      if (s.default === undefined) continue;
      expect(validateSetting(s, s.default).ok).toBe(true);
    }
  });

  it('covers every process.env read in src/', () => {
    // The wizard is only "configure everything" if the schema keeps up with the
    // code. Anything read from the environment but absent here can still only
    // be set by hand-editing .env, which is the problem this exists to fix.
    const srcDir = path.join(process.cwd(), 'src');
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // The config subsystem reads process.env generically, by key, rather
        // than naming settings — nothing there is a setting declaration.
        if (path.relative(srcDir, full).startsWith('config')) continue;
        for (const match of fs.readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
          if (match[1]) found.add(match[1]);
        }
      }
    };
    walk(srcDir);

    const undeclared = [...found].filter((key) => !SETTINGS_BY_KEY.has(key));
    expect(undeclared).toEqual([]);
  });
});

describe('settingsInGroup', () => {
  it('returns the group in schema order', () => {
    expect(settingsInGroup('Connection').map((s) => s.key)).toEqual([
      'DISCORD_TOKEN',
      'ALLOWED_USER_ID',
      'BASE_FOLDER',
    ]);
  });
});

describe('validateSetting', () => {
  it('rejects an empty required value', () => {
    const result = validateSetting(setting('DISCORD_TOKEN'), '   ');
    expect(result).toEqual({ ok: false, error: 'DISCORD_TOKEN is required.' });
  });

  it('accepts an empty optional value as "unset"', () => {
    expect(validateSetting(setting('BOT_INSTANCE_ID'), '')).toEqual({ ok: true, value: '' });
  });

  it('rejects a non-numeric integer', () => {
    const result = validateSetting(setting('MCP_SERVER_PORT'), 'abc');
    expect(result.ok).toBe(false);
  });

  it('enforces integer bounds', () => {
    expect(validateSetting(setting('MCP_SERVER_PORT'), '0').ok).toBe(false);
    expect(validateSetting(setting('MCP_SERVER_PORT'), '70000').ok).toBe(false);
    expect(validateSetting(setting('MCP_SERVER_PORT'), '4000')).toEqual({
      ok: true,
      value: '4000',
      warning: undefined,
    });
  });

  it('normalises the many ways people say yes and no', () => {
    const enable = setting('ENABLE_REACTIONS');
    for (const yes of ['y', 'Y', 'yes', 'true', 'on', '1']) {
      expect(validateSetting(enable, yes)).toEqual({ ok: true, value: 'true' });
    }
    for (const no of ['n', 'no', 'false', 'off', '0']) {
      expect(validateSetting(enable, no)).toEqual({ ok: true, value: 'false' });
    }
    expect(validateSetting(enable, 'maybe').ok).toBe(false);
  });

  it('matches choices case-insensitively but stores the canonical spelling', () => {
    expect(validateSetting(setting('PROMPT_LINK_STYLE'), 'EMBED')).toEqual({
      ok: true,
      value: 'embed',
    });
  });

  it('lists the choices when none matched', () => {
    const result = validateSetting(setting('MCP_DEFAULT_ON_TIMEOUT'), 'maybe');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('deny, allow');
  });

  it('rejects a non-numeric Discord user id with advice', () => {
    const result = validateSetting(setting('ALLOWED_USER_ID'), 'my_username');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Developer Mode');
  });

  it('warns but accepts a user id of the wrong length', () => {
    const result = validateSetting(setting('ALLOWED_USER_ID'), '12345');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toContain('17-20 digits');
  });

  it('spots the .env.example placeholder token', () => {
    const result = validateSetting(setting('DISCORD_TOKEN'), 'your_bot_token_here');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toContain('placeholder');
  });

  it('warns about a token that is missing its dot-separated parts', () => {
    const result = validateSetting(setting('DISCORD_TOKEN'), 'abcdefghijklmnop');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toContain('three dot-separated parts');
  });

  it('strips quotes people paste around a token', () => {
    const result = validateSetting(setting('DISCORD_TOKEN'), '"aaa.bbb.ccc"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('aaa.bbb.ccc');
  });

  it('expands a leading ~ in a path', () => {
    const result = validateSetting(setting('BASE_FOLDER'), '~/repos');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(path.join(os.homedir(), 'repos'));
  });

  it('accepts a base folder that does not exist yet, with a warning', () => {
    const missing = path.join(os.tmpdir(), 'definitely-not-a-real-folder-xyz');
    const result = validateSetting(setting('BASE_FOLDER'), missing);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toContain("doesn't exist");
  });

  it('accepts a base folder that does exist, with no warning', () => {
    const result = validateSetting(setting('BASE_FOLDER'), os.tmpdir());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toBeUndefined();
  });

  it('complains when a base folder points at a file', () => {
    const file = path.join(os.tmpdir(), `bot-base-folder-${process.pid}.txt`);
    fs.writeFileSync(file, 'x');
    try {
      const result = validateSetting(setting('BASE_FOLDER'), file);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.warning).toContain('a file, not a folder');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('maskValue', () => {
  it('shows only the ends of a secret', () => {
    expect(maskValue(setting('DISCORD_TOKEN'), 'abcdefghijklmnop')).toBe('abcd...mnop');
  });

  it('hides a short secret entirely', () => {
    expect(maskValue(setting('DISCORD_TOKEN'), 'abcd')).toBe('****');
  });

  it('leaves non-secrets alone', () => {
    expect(maskValue(setting('BASE_FOLDER'), '/repos')).toBe('/repos');
  });
});
