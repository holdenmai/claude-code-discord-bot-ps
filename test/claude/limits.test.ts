import { describe, it, expect } from 'vitest';
import { detectSessionLimit, limitFromRateLimitEvent } from '../../src/claude/limits.js';

/**
 * Reading a plan limit, and working out when it lifts.
 *
 * Worth testing precisely because getting it wrong is expensive in both
 * directions: miss the limit and the channel retries into it every ten minutes
 * for the whole window, and misread the clock and it sits out a window it could
 * have been working through.
 */

/** A fixed "now" so the arithmetic is checkable rather than approximate. */
const NOON_UTC = Date.UTC(2026, 8, 20, 12, 0, 0);
const MINUTE = 60_000;

/** Wait in whole minutes, ignoring the grace second-hand. */
function waitMinutes(resumeAt: number, now = NOON_UTC): number {
  return Math.round((resumeAt - now) / MINUTE);
}

describe('limitFromRateLimitEvent', () => {
  const event = (info: Record<string, unknown>) => ({ rate_limit_info: info });

  it('reads the exact reset instant the CLI hands us', () => {
    const resetsAt = Math.floor(NOON_UTC / 1000) + 3 * 3600;
    const limit = limitFromRateLimitEvent(
      event({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
      NOON_UTC,
    );

    expect(limit?.label).toBe('5-hour limit');
    expect(limit?.resetsAtEpochSec).toBe(resetsAt);
    // Three hours, plus the minute of grace.
    expect(waitMinutes(limit!.resumeAt)).toBe(181);
  });

  it('ignores informational events, which fire before the limit bites', () => {
    expect(
      limitFromRateLimitEvent(event({ status: 'allowed', resetsAt: 1 }), NOON_UTC),
    ).toBeUndefined();
    expect(limitFromRateLimitEvent({}, NOON_UTC)).toBeUndefined();
    expect(limitFromRateLimitEvent(undefined, NOON_UTC)).toBeUndefined();
  });

  it('names the limit it hit', () => {
    expect(
      limitFromRateLimitEvent(event({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1 }), NOON_UTC)?.label,
    ).toBe('7-day limit');
    expect(
      limitFromRateLimitEvent(event({ status: 'rejected', rateLimitType: 'daily', resetsAt: 1 }), NOON_UTC)?.label,
    ).toBe('daily limit');
  });

  it('falls back to a blind wait when the event carries no reset time', () => {
    const limit = limitFromRateLimitEvent(event({ status: 'rejected' }), NOON_UTC);
    expect(waitMinutes(limit!.resumeAt)).toBe(15);
    expect(limit?.label).toContain('no reset time');
  });

  it('treats a reset already in the past as imminent rather than negative', () => {
    // Clock skew, or an event we got to late. Waiting a moment and re-arming
    // with a fresher time beats scheduling a retry in the past.
    const limit = limitFromRateLimitEvent(
      event({ status: 'rejected', resetsAt: Math.floor(NOON_UTC / 1000) - 9999 }),
      NOON_UTC,
    );
    expect(limit!.resumeAt).toBeGreaterThan(NOON_UTC);
    expect(waitMinutes(limit!.resumeAt)).toBe(1);
  });
});

describe('detectSessionLimit', () => {
  it('ignores ordinary failures', () => {
    // Everything else must keep its existing meaning: a real failure should
    // still go down the normal API-error retry, or fail the turn.
    expect(detectSessionLimit(undefined, NOON_UTC)).toBeUndefined();
    expect(detectSessionLimit('error_during_execution', NOON_UTC)).toBeUndefined();
    expect(detectSessionLimit('Unable to connect to API', NOON_UTC)).toBeUndefined();
    expect(detectSessionLimit('git add failed (128)', NOON_UTC)).toBeUndefined();
  });

  it('reads the message the CLI produces', () => {
    const limit = detectSessionLimit(
      'API Error: 429 You\'ve hit your session limit resets 5:20 pm (America/Denver)',
      NOON_UTC,
    );

    expect(limit).toBeDefined();
    expect(limit?.label).toContain('5:20 pm');
    expect(limit?.label).toContain('America/Denver');
    // Noon UTC is 06:00 in Denver (MDT), so 5:20 pm is 11h20m away.
    expect(waitMinutes(limit!.resumeAt)).toBe(11 * 60 + 21); // +1 minute of grace
  });

  it('matches the structured error type as well as the prose', () => {
    expect(detectSessionLimit('{"type":"rate_limit_error"}', NOON_UTC)).toBeDefined();
  });

  it('waits until tomorrow when the reset time has already passed today', () => {
    // Modulo a day: a limit quoting 11:00 at noon means tomorrow morning, and
    // resuming immediately would just re-arm it.
    const limit = detectSessionLimit('usage limit resets 11:00 (UTC)', NOON_UTC);

    expect(waitMinutes(limit!.resumeAt)).toBe(23 * 60 + 1);
  });

  it('handles a 24-hour clock and a missing zone', () => {
    const limit = detectSessionLimit('rate limited — resets 13:30', NOON_UTC);

    expect(limit).toBeDefined();
    expect(limit?.label).toBe('13:30');
  });

  it('treats midday and midnight correctly', () => {
    // 12am is 00:00, twelve hours after noon.
    expect(
      waitMinutes(detectSessionLimit('session limit resets 12:00 am (UTC)', NOON_UTC)!.resumeAt),
    ).toBe(12 * 60 + 1);
    // 12pm is noon itself: on the minute, so treated as imminent.
    expect(
      waitMinutes(detectSessionLimit('session limit resets 12:00 pm (UTC)', NOON_UTC)!.resumeAt),
    ).toBe(2);
  });

  it('still waits when the message gives no time', () => {
    // A blind wait beats hammering the limit, and beats failing a prompt that
    // is only early.
    const limit = detectSessionLimit('You have hit your usage limit.', NOON_UTC);

    expect(limit).toBeDefined();
    expect(waitMinutes(limit!.resumeAt)).toBe(15);
    expect(limit?.label).toContain('no reset time');
  });

  it('falls back rather than throwing on a zone it does not know', () => {
    const limit = detectSessionLimit('session limit resets 5:20 pm (Mars/Olympus)', NOON_UTC);

    expect(limit).toBeDefined();
    expect(limit!.resumeAt).toBeGreaterThan(NOON_UTC);
  });

  it('refuses a time that is not one', () => {
    expect(waitMinutes(detectSessionLimit('session limit resets 99:99', NOON_UTC)!.resumeAt)).toBe(15);
  });
});
