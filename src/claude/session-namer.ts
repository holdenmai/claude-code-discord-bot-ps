import { spawn } from "child_process";

/**
 * Asking Claude to name a session that's being put away (`/autopause`).
 *
 * The naming run is deliberately *outside* everything else the bot does with the
 * CLI: it never enters the per-channel message queue, is never registered as the
 * channel's active process, and never streams into Discord. That's the whole
 * point of /autopause — the session is already paused by the time this runs, so
 * the user can start their next session immediately while the name catches up.
 *
 * It resumes the paused session (so Claude actually knows what the work was)
 * with --fork-session, which puts the naming turn in a throwaway session id and
 * leaves the paused session's own transcript exactly as the user left it.
 */

/**
 * Cap on a generated name. Paused names are typed into `/resume` and packed into
 * its autocomplete labels ("<name> (paused 3h ago)", Discord caps those at 100),
 * so short matters more than descriptive.
 */
export const SESSION_NAME_MAX = 32;

/** How long to wait for a name before giving up and leaving the session under its id. */
const NAMING_TIMEOUT_MS = Number(process.env.AUTOPAUSE_TIMEOUT_SECONDS || 180) * 1000;

// A generated name that looks like a session id would shadow that id in
// /resume, which resolves paused names before GUIDs. Reject the shape outright.
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Labels Claude sometimes prefixes despite being told to answer with the name
// alone ("Name: foo", "The name is: foo").
const LABEL_RE = /^(?:the\s+)?(?:session\s+)?name\s*(?:is)?\s*[:\-]?\s*/i;

/** The prompt handed to the paused session. */
export function buildNamingPrompt(maxLength: number = SESSION_NAME_MAX): string {
  return [
    "We are pausing this session to possibly be picked up later by name.",
    "I need a very short name that tells me at a glance what this session was for.",
    "",
    "Rules for the name:",
    `- at most ${maxLength} characters`,
    "- lowercase letters, digits and hyphens only, no spaces",
    "- name the concrete subject (the feature, bug, file or repo area), not generic words like session, work, task or chat",
    "",
    "Your response must contain ONLY the name, nothing else: no quotes, no punctuation, no explanation.",
  ].join("\n");
}

/**
 * Coerce whatever Claude actually said into a usable name, or undefined if it
 * can't be salvaged (the caller then leaves the session named after its id).
 *
 * Read from the end: when a model ignores "ONLY the name" it explains first and
 * answers last, so the final line is the best candidate.
 */
export function sanitizeSessionName(
  raw: string | undefined,
  maxLength: number = SESSION_NAME_MAX
): string | undefined {
  if (!raw) return undefined;

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return undefined;

  // Strip list bullets, surrounding quotes/backticks, and a "Name:" label.
  let candidate = last
    .replace(/^[-*•]\s+/, "")
    .replace(LABEL_RE, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();

  candidate = candidate.replace(/[.!?]+$/, "").trim();

  if (/\s/.test(candidate)) {
    // Multiple words: a short phrase ("fix queue deadlock") hyphenates into a
    // fine name, but a sentence is prose that happens to end the reply — and
    // hyphenating that produces a name that's worse than the session id.
    const words = candidate.split(/\s+/);
    if (words.length > 4) return undefined;
    candidate = words.join("-");
  }

  let cleaned = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Check the shape *before* truncating: a session id is 36 characters and
  // would otherwise be cut down to something that no longer matches here.
  if (GUID_RE.test(cleaned)) return undefined;

  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
    // Prefer cutting at a word boundary — "fix-queue" beats "fix-queue-dea".
    const cut = cleaned.lastIndexOf("-");
    if (cut >= 2) cleaned = cleaned.slice(0, cut);
    cleaned = cleaned.replace(/-+$/g, "");
  }

  if (cleaned.length < 2) return undefined;
  return cleaned;
}

/**
 * Make a name unique within a channel. paused_sessions is keyed on
 * (channel_id, name) and written with INSERT OR REPLACE, so reusing a name would
 * silently destroy the session already parked under it.
 */
export function uniqueSessionName(
  base: string,
  taken: Iterable<string>,
  maxLength: number = SESSION_NAME_MAX
): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, maxLength - suffix.length).replace(/-+$/g, "") + suffix;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

export interface NamingRunOptions {
  sessionId: string;
  workingDir: string;
  model: string;
  maxLength?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
}

/**
 * Run the naming prompt against a paused session and return a sanitized name.
 * Resolves to undefined on any failure — a missing name is never fatal, it just
 * leaves the session parked under its id.
 */
export function requestSessionName(options: NamingRunOptions): Promise<string | undefined> {
  const {
    sessionId,
    workingDir,
    model,
    maxLength = SESSION_NAME_MAX,
    timeoutMs = NAMING_TIMEOUT_MS,
    spawnFn = spawn,
  } = options;

  const args = [
    "--resume",
    sessionId,
    // Fork so the naming turn lands in a throwaway session and the paused
    // session's transcript is byte-identical to what the user left behind.
    "--fork-session",
    "--model",
    model,
    "-p",
    buildNamingPrompt(maxLength),
  ];

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: workingDir,
        env: { ...process.env },
      });
    } catch (error) {
      console.error("Failed to spawn session-naming process:", error);
      resolve(undefined);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (name: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(name);
    };

    const timer = setTimeout(() => {
      console.error(`Session naming timed out after ${timeoutMs}ms for ${sessionId}`);
      try { child.kill("SIGTERM"); } catch {}
      finish(undefined);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => {
      console.error(`Session naming stderr: ${d.toString().trim()}`);
    });
    child.on("error", (error: Error) => {
      console.error("Session naming process error:", error);
      finish(undefined);
    });
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        console.error(`Session naming exited with code ${code}`);
        finish(undefined);
        return;
      }
      finish(sanitizeSessionName(stdout, maxLength));
    });
  });
}
