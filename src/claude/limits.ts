/**
 * Recognising a plan limit, and working out when it lifts.
 *
 * Ported from the `aiontheloose` project's `src/core/limits.ts`, which arrived
 * at this by running into it repeatedly.
 *
 * The bot already retries API-layer failures forever with an escalating
 * backoff, and a usage limit arrives looking exactly like one: `API Error: 429`
 * matches the `"api error"` marker, so the channel spends the whole window
 * rediscovering the same limit every ten minutes, posting an embed each time,
 * with the queue held throughout. The retry is not wrong — the *interval* is,
 * because the limit says when it lifts and the backoff ignores it.
 *
 * So the limit has to be recognised by name, separately from the generic API
 * error, and it says when it lifts — "session limit resets 5:20 pm
 * (America/Denver)". Parsing that is worth doing because the alternative is
 * guessing, and a guess that is too short spends the window rediscovering the
 * limit one spawn at a time.
 */

/** Phrases the CLI uses when the account, not the work, is the problem. */
const LIMIT_PATTERNS = [
  /\bsession limit\b/i,
  /\busage limit\b/i,
  /\brate limit(ed)?\b/i,
  /\blimit (?:will )?reset/i,
  /\brate_limit_error\b/i,
];

/**
 * `5:20 pm`, `17:20`, with an optional zone in brackets after it.
 *
 * The zone half matches both `(America/Denver)` and a bare `(UTC)`, and is
 * deliberately loose about what it accepts: anything unrecognised is handed to
 * `Intl`, which throws, and the fallback is local time. Being strict here would
 * silently read a quoted zone as local — the same wait, computed against the
 * wrong clock, which is a wait that ends at the wrong time.
 */
const RESET_AT =
  /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b(?:[^()\n]{0,40}\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)?)\))?/i;

/** Long enough that the reset has definitely landed, short enough to not waste it. */
const GRACE_MS = 60_000;

/** When a limit gives no time at all, wait this long before probing again. */
const BLIND_WAIT_MS = Number(process.env.LIMIT_BLIND_WAIT_MINUTES || 15) * 60_000;

export interface SessionLimit {
  /** Epoch ms to wait until before trying again. */
  resumeAt: number;
  /** What the limit said, for the log and the channel. */
  label: string;
  /**
   * The reset instant in unix *seconds*, when the CLI gave us one outright.
   * Kept separately from `resumeAt` (which carries the grace period) so the
   * embed can render Discord's `<t:…:R>` live countdown against the real time.
   */
  resetsAtEpochSec?: number;
  /**
   * Set once this window has been announced in Discord, so the same limit
   * reported twice (the `rate_limit_event` and then the turn's error result)
   * produces one message rather than two.
   */
  announced?: boolean;
}

/**
 * The good case: the CLI says so itself.
 *
 * `rate_limit_event` carries `resetsAt` as unix seconds — an exact instant,
 * with none of the guesswork below. The bot already received this event and
 * only announced it; reading it here is what turns the announcement into a
 * schedule.
 */
export function limitFromRateLimitEvent(parsed: any, now: number): SessionLimit | undefined {
  const info = parsed?.rate_limit_info;
  // Informational events fire well before the limit bites. Only a rejection
  // means work was actually refused.
  if (!info || info.status !== "rejected") return undefined;

  const typeLabels: Record<string, string> = {
    five_hour: "5-hour",
    seven_day: "7-day",
    daily: "daily",
  };
  const kind = typeLabels[info.rateLimitType] || info.rateLimitType || "rate";

  const seconds = Number(info.resetsAt);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { resumeAt: now + BLIND_WAIT_MS, label: `${kind} limit, no reset time given` };
  }

  // A reset already in the past means the clocks disagree, or the event is
  // stale. Retrying a moment from now is right either way — the worst case is
  // one spawn that re-arms the window with a fresher time.
  const resumeAt = Math.max(now + GRACE_MS, seconds * 1000 + GRACE_MS);
  return { resumeAt, label: `${kind} limit`, resetsAtEpochSec: seconds };
}

/**
 * The wall-clock time right now in a named zone, as minutes past midnight.
 *
 * Done with `Intl` rather than date arithmetic because the only question that
 * matters is "how far from now is that clock face", and offsets, DST and the
 * date rolling over all cancel out of that subtraction.
 */
function minutesNowIn(timeZone: string | undefined, now: number): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(now));

    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
    // `24` appears for midnight in some ICU versions.
    return (hour % 24) * 60 + minute;
  } catch {
    // An unknown zone. Falling back to local time is better than not waiting.
    return undefined;
  }
}

/**
 * Is this the account saying no, rather than the work going wrong?
 *
 * Returns when to try again, or `undefined` when the error is an ordinary one.
 */
export function detectSessionLimit(
  text: string | undefined | null,
  now: number,
): SessionLimit | undefined {
  if (!text) return undefined;
  if (!LIMIT_PATTERNS.some((pattern) => pattern.test(text))) return undefined;

  const match = RESET_AT.exec(text);
  if (!match) {
    return { resumeAt: now + BLIND_WAIT_MS, label: "no reset time given" };
  }

  const [, rawHour = "", rawMinute = "", meridiem, zone] = match;
  let hour = Number(rawHour);
  const minute = Number(rawMinute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59 || hour > 23) {
    return { resumeAt: now + BLIND_WAIT_MS, label: "unreadable reset time" };
  }

  if (meridiem) {
    const pm = meridiem.toLowerCase() === "pm";
    hour = hour % 12;
    if (pm) hour += 12;
  }

  const target = hour * 60 + minute;
  const current = minutesNowIn(zone, now) ?? minutesNowIn(undefined, now);
  if (current === undefined) {
    return { resumeAt: now + BLIND_WAIT_MS, label: "clock unavailable" };
  }

  // Modulo a day, so a reset time that has already passed today is tomorrow's.
  // Zero means the clock is on the reset minute right now; waiting the whole
  // day would be absurd, so treat it as imminent.
  const delta = (target - current + 1440) % 1440;
  const waitMs = (delta === 0 ? 1 : delta) * 60_000 + GRACE_MS;

  return {
    resumeAt: now + waitMs,
    label: `${rawHour}:${rawMinute}${meridiem ? ` ${meridiem.toLowerCase()}` : ""}${
      zone ? ` (${zone})` : ""
    }`,
  };
}
