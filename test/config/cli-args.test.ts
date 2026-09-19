import { describe, it, expect } from 'vitest';
import { USAGE, parseCliArgs } from '../../src/config/cli-args.js';

describe('parseCliArgs', () => {
  it('defaults to just starting the bot', () => {
    expect(parseCliArgs([])).toEqual({
      config: false,
      configOnly: false,
      help: false,
      unknown: [],
    });
  });

  it('accepts one and two dashes alike', () => {
    expect(parseCliArgs(['-config']).config).toBe(true);
    expect(parseCliArgs(['--config']).config).toBe(true);
  });

  it('treats -configonly as config plus stop', () => {
    const args = parseCliArgs(['-configonly']);
    expect(args.configOnly).toBe(true);
    expect(args.config).toBe(true);
  });

  it('accepts the hyphenated spelling of config-only', () => {
    expect(parseCliArgs(['--config-only']).configOnly).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(parseCliArgs(['-ConfigOnly']).configOnly).toBe(true);
  });

  it('recognises the usual help spellings', () => {
    for (const flag of ['-h', '--help', '-help', '-?']) {
      expect(parseCliArgs([flag]).help).toBe(true);
    }
  });

  it('reports unknown flags instead of ignoring them', () => {
    expect(parseCliArgs(['--wat']).unknown).toEqual(['--wat']);
  });

  it('ignores bare words, which are not flags', () => {
    expect(parseCliArgs(['somefile.ts']).unknown).toEqual([]);
  });

  it('documents both config flags in the usage text', () => {
    expect(USAGE).toContain('-config');
    expect(USAGE).toContain('-configonly');
  });
});
