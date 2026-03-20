import { describe, it, expect } from 'vitest';
import { escapeShellString, buildClaudeCommand } from '../../src/utils/shell.js';

describe('escapeShellString', () => {
  it('should wrap simple strings in single quotes', () => {
    expect(escapeShellString('hello world')).toBe("'hello world'");
  });

  it('should escape single quotes by doubling them (PowerShell)', () => {
    expect(escapeShellString("don't")).toBe("'don''t'");
  });

  it('should handle multiple single quotes', () => {
    expect(escapeShellString("can't won't")).toBe("'can''t won''t'");
  });

  it('should handle empty string', () => {
    expect(escapeShellString('')).toBe("''");
  });

  it('should handle string with only single quotes', () => {
    expect(escapeShellString("'''")).toBe("''''''''");
  });
});

describe('buildClaudeCommand', () => {
  it('should build basic command without session ID', () => {
    const { command, args } = buildClaudeCommand('/test/dir', 'hello world');
    expect(command).toBe("claude");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
    expect(args).toContain("-p");
    expect(args).toContain("hello world");
    expect(args).toContain("--verbose");
  });

  it('should build command with session ID', () => {
    const { args } = buildClaudeCommand('/test/dir', 'hello world', 'session-123');
    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
    expect(args).toContain("-p");
    expect(args).toContain("hello world");
  });

  it('should pass prompt with special characters as-is (no shell escaping needed)', () => {
    const { args } = buildClaudeCommand('/test/dir', "don't use this");
    expect(args).toContain("-p");
    expect(args).toContain("don't use this");
  });

  it('should preserve double quotes in prompts', () => {
    const { args } = buildClaudeCommand('/test/dir', 'Status code "does not exist"');
    expect(args).toContain("-p");
    expect(args).toContain('Status code "does not exist"');
  });

  it('should handle complex prompts', () => {
    const prompt = "Fix the bug in 'config.js' and don't break anything";
    const { args } = buildClaudeCommand('/project/path', prompt, 'abc-123');
    expect(args).toContain("--resume");
    expect(args).toContain("abc-123");
    expect(args).toContain("-p");
    expect(args).toContain(prompt);
  });
});
