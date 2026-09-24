import { describe, it, expect } from 'vitest';
import { detectAuthFailure } from '../../src/claude/auth.js';

/**
 * Recognising a login that has stopped working.
 *
 * The asymmetry is the whole design: a false negative costs one wasted spawn
 * and falls back to the ordinary API-error retry, while a false positive stops
 * every channel on the machine and tells someone whose login is fine to go and
 * fix it. So the interesting tests here are the ones that must *not* match.
 */

describe('detectAuthFailure', () => {
  it('names the expired token cases', () => {
    expect(detectAuthFailure('OAuth token has expired')).toBe('the OAuth token has expired');
    expect(detectAuthFailure('The oauth token expired')).toBe('the OAuth token has expired');
    expect(detectAuthFailure('refresh token has been revoked')).toBe('the refresh token has expired');
  });

  it('recognises the CLI asking for a login', () => {
    expect(detectAuthFailure('Please run /login to continue')).toBe('the CLI asked for a login');
    expect(detectAuthFailure('run `claude setup-token`')).toBe('the CLI asked for a login');
  });

  it("recognises the API's own refusals", () => {
    expect(detectAuthFailure('{"type":"authentication_error"}')).toBe(
      'the API refused to authenticate this account',
    );
    expect(detectAuthFailure('Invalid API key')).toBe('the API key was rejected');
    expect(detectAuthFailure('API Error: 401 Unauthorized')).toBe('the API answered 401 Unauthorized');
    expect(detectAuthFailure('Unauthorized (status 401)')).toBe('the API answered 401 Unauthorized');
  });

  it('reads whichever argument carried the evidence', () => {
    // The real shape of this failure: the stream says nothing useful because
    // the CLI exited before it had a result, and stderr has the reason.
    expect(detectAuthFailure(undefined, 'OAuth token has expired')).toBeDefined();
    expect(detectAuthFailure('process exited with code 1', 'invalid api key')).toBeDefined();
  });

  it('ignores ordinary output', () => {
    expect(detectAuthFailure(undefined)).toBeUndefined();
    expect(detectAuthFailure('')).toBeUndefined();
    expect(detectAuthFailure('Task completed successfully')).toBeUndefined();
    expect(detectAuthFailure('Unable to connect to API')).toBeUndefined();
  });

  it('does not fire on a bare 401 or a bare "unauthorized"', () => {
    // Both turn up in ordinary tool output — an HTTP log, a curl against
    // someone else's API, a test fixture. Neither is this bot's login.
    expect(detectAuthFailure('GET /api/thing 401')).toBeUndefined();
    expect(detectAuthFailure('the endpoint returned unauthorized')).toBeUndefined();
    expect(detectAuthFailure('expect(res.status).toBe(401)')).toBeUndefined();
  });

  it('does not fire on a rate limit, which is a different answer entirely', () => {
    expect(detectAuthFailure('API Error: 429 rate_limit_error')).toBeUndefined();
    expect(detectAuthFailure("You've hit your session limit resets 5:20 pm")).toBeUndefined();
  });
});
