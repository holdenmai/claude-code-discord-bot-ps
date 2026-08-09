/**
 * Helpers for reasoning about Discord interaction failures.
 *
 * Discord gives you a 3-second window to send the FIRST response to an
 * interaction. Missing it (event-loop stalls, double-clicks, stale buttons)
 * makes the ack reject with a well-known error code. Those rejections are
 * expected on a busy bot and must never be fatal — but we still want REAL
 * bugs (a bad embed, a permissions error, a thrown TypeError) to surface
 * loudly instead of being silently swallowed.
 *
 * This predicate is the dividing line between the two.
 */

// Discord API error codes (JSONErrorCodes). See:
// https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
export const DISCORD_UNKNOWN_INTERACTION = 10062; // ack arrived after the 3s window
export const DISCORD_INTERACTION_ALREADY_ACKED = 40060; // acknowledged twice

/**
 * Return true when `error` is an EXPECTED, non-fatal Discord interaction
 * failure that we can safely log-and-ignore. Return false for everything
 * else so the caller re-throws / logs it as a real problem.
 */
export function isBenignInteractionError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === DISCORD_UNKNOWN_INTERACTION || code === DISCORD_INTERACTION_ALREADY_ACKED;
}
