import { describe, it, expect, vi } from 'vitest';
import { PermissionManager } from '../../src/mcp/permission-manager.js';
import type { PendingApproval, Question } from '../../src/mcp/discord-context.js';

/**
 * Build a 3-question prompt with the first question already answered, seed it
 * into the manager's pending map, and return handles for assertions.
 */
function seedTimedOutQuestion(pm: PermissionManager) {
  const questions: Question[] = [
    {
      question: 'Which database?',
      header: 'DB',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'relational' },
        { label: 'SQLite', description: 'embedded' },
      ],
    },
    {
      question: 'Which cache?',
      header: 'Cache',
      multiSelect: false,
      options: [
        { label: 'Redis', description: 'in-memory' },
        { label: 'Memcached', description: 'in-memory' },
      ],
    },
    {
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Auth', description: 'login' },
        { label: 'Billing', description: 'payments' },
      ],
    },
  ];

  const edit = vi.fn().mockResolvedValue(undefined);
  const resolve = vi.fn();

  const pending: PendingApproval = {
    requestId: 'req_test',
    toolName: 'AskUserQuestion',
    input: { questions },
    discordContext: { channelId: 'c1', channelName: 'chan', userId: 'u1' },
    resolve,
    reject: vi.fn(),
    timeout: setTimeout(() => {}, 0),
    discordMessage: { edit },
    createdAt: new Date(0),
    pendingQuestion: {
      currentQuestionIndex: 1, // advanced past Q1 (answered), sitting on Q2 when time ran out
      answers: { 'Which database?': 'Postgres' },
      questions,
    },
  };
  clearTimeout(pending.timeout);

  (pm as any).pendingApprovals.set(pending.requestId, pending);
  return { pending, edit, resolve };
}

describe('AskUserQuestion timeout preserves the full multi-question record', () => {
  it('leaves every question and option in the edited message on timeout', () => {
    const pm = new PermissionManager();
    const { edit, resolve } = seedTimedOutQuestion(pm);

    (pm as any).handleQuestionTimeout('req_test');

    // The tool call still resolves (default deny, display-only fix).
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0][0].behavior).toBe('deny');

    // The message is edited to a single record with controls removed.
    expect(edit).toHaveBeenCalledTimes(1);
    const payload = edit.mock.calls[0][0];
    expect(payload.components).toEqual([]);

    const description = payload.embeds[0].data.description as string;

    // All three questions survive — not just the one that was on screen.
    expect(description).toContain('Which database?');
    expect(description).toContain('Which cache?');
    expect(description).toContain('Which features?');

    // Every option label is preserved for review.
    for (const label of ['Postgres', 'SQLite', 'Redis', 'Memcached', 'Auth', 'Billing']) {
      expect(description).toContain(label);
    }

    // The answered option is marked; the unanswered questions show "(no answer)".
    expect(description).toContain('✅ Postgres');
    expect(description).toContain('▫️ SQLite');
    expect(description).toContain('(no answer)');
  });

  it('is a no-op when the request is unknown or has no pending question', () => {
    const pm = new PermissionManager();
    expect(() => (pm as any).handleQuestionTimeout('does_not_exist')).not.toThrow();
  });
});
