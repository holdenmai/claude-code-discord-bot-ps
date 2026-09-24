/**
 * Recognising a login that has stopped working.
 *
 * Ported from the `aiontheloose` project's `src/core/auth.ts`.
 *
 * The sibling of `limits.ts`, and the same failure dressed differently. A plan
 * limit is the account saying "not now"; an expired OAuth token is it saying
 * "not you" — and both reach this bot as `API Error: …`, which the existing
 * marker list already matches. For a limit that produces a retry at the wrong
 * interval. For a dead token it produces something worse: a retry loop that can
 * never succeed, re-spawning every ten minutes forever, with the channel's
 * queue held the whole time. Nothing about a dead token clears itself, because
 * the fix is a human at a terminal typing `claude login`.
 *
 * So this half of the problem is not really about the retry interval at all —
 * it is about saying so loudly enough, in a place that is being looked at, and
 * then checking cheaply and often enough that the held work resumes by itself
 * once the login is back.
 *
 * Detection is deliberately conservative. A false negative costs one wasted
 * spawn and falls back to the existing API-error retry; a false positive puts a
 * "you are not logged in" banner in front of someone whose login is fine and
 * stops every channel on the machine. So each pattern here has to be a phrase
 * that only an authentication failure produces — `unauthorized` on its own is
 * not one, and neither is a bare `401`.
 */

/** What the CLI and the API say when the credentials are the problem. */
const SIGNS: [RegExp, string][] = [
  [/\boauth token (?:has )?expired\b/i, "the OAuth token has expired"],
  [/\brefresh token (?:has )?(?:expired|been revoked|is invalid)\b/i, "the refresh token has expired"],
  [/\boauth (?:token|credentials?) (?:is |are |was |were )?(?:invalid|revoked)\b/i, "the OAuth token was rejected"],
  [/\bplease run\s*`?\/?(?:claude\s+)?login\b/i, "the CLI asked for a login"],
  [/\brun\s+`?claude\s+(?:login|setup-token)\b/i, "the CLI asked for a login"],
  [/\binvalid api key\b/i, "the API key was rejected"],
  [/\bauthentication_error\b/i, "the API refused to authenticate this account"],
  [/\bauthentication failed\b/i, "authentication failed"],
  [/\bnot (?:logged in|authenticated)\b/i, "the CLI is not logged in"],
  [/\bcredentials?\b[^\n]{0,40}\b(?:expired|invalid|missing|not found)\b/i, "the stored credentials are no longer valid"],
  // A bare 401 is not enough — plenty of tool output contains one — but a 401
  // next to the word is the API's own refusal and nothing else.
  [/\b401\b[^\n]{0,60}\bunauthoriz/i, "the API answered 401 Unauthorized"],
  [/\bunauthoriz(?:ed|ation)\b[^\n]{0,60}\b401\b/i, "the API answered 401 Unauthorized"],
];

/**
 * Is this failure the login rather than the work?
 *
 * Takes several strings because an expired token usually does not come back as
 * a tidy error result: the CLI can exit before it has one to report, so what
 * the stream says is nothing useful and the actual reason is the last thing it
 * wrote to stderr. Both halves get read.
 *
 * Returns a short phrase naming what went wrong, for the log and the alert.
 */
export function detectAuthFailure(...text: (string | undefined | null)[]): string | undefined {
  const joined = text.filter(Boolean).join("\n");
  if (joined === "") return undefined;

  for (const [pattern, label] of SIGNS) {
    if (pattern.test(joined)) return label;
  }
  return undefined;
}
