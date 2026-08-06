import { describe, it, expect } from 'vitest';
import {
  buildNamingPrompt,
  sanitizeSessionName,
  uniqueSessionName,
  SESSION_NAME_MAX,
} from '../../src/claude/session-namer.js';

describe('buildNamingPrompt', () => {
  it('states the length limit it was given', () => {
    expect(buildNamingPrompt(24)).toContain('at most 24 characters');
    expect(buildNamingPrompt()).toContain(`at most ${SESSION_NAME_MAX} characters`);
  });

  it('demands the name and nothing else', () => {
    const prompt = buildNamingPrompt();
    expect(prompt).toContain('ONLY the name');
    expect(prompt).toContain('no spaces');
  });
});

describe('sanitizeSessionName', () => {
  it('accepts a clean answer', () => {
    expect(sanitizeSessionName('autopause-command')).toBe('autopause-command');
  });

  it('trims surrounding whitespace and newlines', () => {
    expect(sanitizeSessionName('\n  fix-queue-deadlock \n')).toBe('fix-queue-deadlock');
  });

  it('strips quotes, backticks and bullets', () => {
    expect(sanitizeSessionName('`fix-queue`')).toBe('fix-queue');
    expect(sanitizeSessionName('"fix-queue"')).toBe('fix-queue');
    expect(sanitizeSessionName('- fix-queue')).toBe('fix-queue');
  });

  it('reads the last line when Claude explains first', () => {
    expect(sanitizeSessionName('Looking at this session:\n\nmcp-permission-retry')).toBe(
      'mcp-permission-retry'
    );
  });

  it('drops a "Name:" label', () => {
    expect(sanitizeSessionName('Name: transcript-import')).toBe('transcript-import');
    expect(sanitizeSessionName('The name is: transcript-import')).toBe('transcript-import');
  });

  it('hyphenates a short unhyphenated phrase', () => {
    expect(sanitizeSessionName('fix queue deadlock')).toBe('fix-queue-deadlock');
  });

  it('rejects prose rather than mangling it into a name', () => {
    expect(sanitizeSessionName('I was not able to determine a topic.')).toBeUndefined();
    expect(
      sanitizeSessionName('this session covered a lot of different unrelated things')
    ).toBeUndefined();
  });

  it('normalizes case and illegal characters', () => {
    expect(sanitizeSessionName('Fix_Queue Deadlock!')).toBe('fix-queue-deadlock');
  });

  it('truncates to the limit without leaving a trailing hyphen', () => {
    const long = 'aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddddddd';
    const result = sanitizeSessionName(long, 12)!;
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.endsWith('-')).toBe(false);
    expect(result).toBe('aaaaaaaaaa');
  });

  it('rejects a GUID-shaped name, which would shadow a session id in /resume', () => {
    expect(sanitizeSessionName('0f8fad5b-d9cb-469f-a165-70867728950e')).toBeUndefined();
  });

  it('rejects empty, punctuation-only and one-character answers', () => {
    expect(sanitizeSessionName('')).toBeUndefined();
    expect(sanitizeSessionName(undefined)).toBeUndefined();
    expect(sanitizeSessionName('...')).toBeUndefined();
    expect(sanitizeSessionName('x')).toBeUndefined();
  });
});

describe('uniqueSessionName', () => {
  it('keeps the name when it is free', () => {
    expect(uniqueSessionName('refactor', ['other'])).toBe('refactor');
  });

  it('suffixes past a collision', () => {
    expect(uniqueSessionName('refactor', ['refactor'])).toBe('refactor-2');
    expect(uniqueSessionName('refactor', ['refactor', 'refactor-2'])).toBe('refactor-3');
  });

  it('keeps the suffixed name within the limit', () => {
    const base = 'a'.repeat(SESSION_NAME_MAX);
    const result = uniqueSessionName(base, [base]);
    expect(result.length).toBeLessThanOrEqual(SESSION_NAME_MAX);
    expect(result.endsWith('-2')).toBe(true);
  });
});
