import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { SDKMessage, CompletionStatus, PromptLinkConfig } from "../types/index.js";
import { getPromptLinkConfig } from "../types/index.js";
import { buildClaudeCommand, isRawCommand, type DiscordContext } from "../utils/shell.js";
import { killProcessTree } from "../utils/process-tree.js";
import { DatabaseManager } from "../db/database.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { detectSessionLimit, limitFromRateLimitEvent, type SessionLimit } from "./limits.js";
import { detectAuthFailure } from "./auth.js";

export type OnCompleteCallback = (channelId: string, status: CompletionStatus, originalMessage: any) => void;

// Model a brand-new session starts on. A full model ID, not a bare "opus"
// alias: aliases follow whatever the CLI currently points that tier at, so a
// tier moving underneath us would silently change every channel at once.
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-5";

// Model for sessions that predate per-session pinning (session_model IS NULL).
// They were created and have been running under the previous Opus, so that's
// what they resume on rather than being jumped forward mid-conversation.
export const LEGACY_SESSION_MODEL = process.env.LEGACY_SESSION_MODEL || "claude-opus-4-8";

// Bare tier aliases resolve to whatever the CLI currently points that tier at.
// Channels configured with one before /model offered explicit versions would
// otherwise pin a *floating* name at session creation, which defeats pinning —
// so aliases are resolved to a concrete ID at the moment a session is created.
const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// How long to wait for the CLI to say *anything* after we hand it the answers to
// an AskUserQuestion. On the healthy path the tool_result comes back over stdout
// within seconds — before any thinking — so silence this long means the turn is
// wedged, not slow. Deliberately far below the 10-minute inactivity reaper, which
// would otherwise sit on a dead turn for the full window and then lose the answers.
const QUESTION_ANSWER_WATCHDOG_MS = Number(process.env.QUESTION_WATCHDOG_SECONDS || 120) * 1000;

// How long a channel's CLI process is kept alive with nothing to do.
//
// This is not an optimisation, it's the feature: the CLI tears down every
// background task (Monitor, `run_in_background` shells) roughly 5 seconds after a
// turn's `result` *if stdin has reached EOF*. Hold stdin open and the same task
// runs to completion, fires its notification, and the CLI wakes itself for a
// follow-up turn (`result.origin.kind === "task-notification"`). So a watcher
// lives exactly as long as we're willing to keep its process around.
//
// Holding it open also means the next prompt is a stdin injection rather than a
// `--resume`, which re-reads the whole transcript. That's the cheap part.
const IDLE_KEEPALIVE_MS = Number(process.env.SESSION_IDLE_SECONDS || 600) * 1000;

// Absolute ceiling on holding a process open for background work, so a watcher
// that never terminates can't pin a CLI (and its MCP bridge) open forever.
const MAX_TASK_HOLD_MS = Number(process.env.WATCHER_MAX_HOLD_SECONDS || 6 * 3600) * 1000;

// Silence allowed *within a turn* before the process is treated as hung. Long or
// slow API turns can go quiet for minutes at a time — especially when Anthropic
// is overloaded — so keep it generous. It is never armed on an idle process,
// which is supposed to be silent.
//
// Configurable because the CLI's own foreground Bash cap is 600 seconds exactly:
// a build or test suite run at the top of that range produces no output for the
// whole window and lands on this timer's default by coincidence.
const INACTIVITY_MS = Number(process.env.TURN_INACTIVITY_SECONDS || 600) * 1000;

// Grace given to a deliberate shutdown: stdin EOF is the front door (the CLI
// drains, tears down its own background tasks and exits 0), SIGTERM the
// escalation if it doesn't take it.
const SHUTDOWN_GRACE_MS = 8000;

/**
 * The spawn-time identity of a channel's CLI process. These live in argv, so a
 * turn that needs different ones can't be injected into an existing process —
 * it has to respawn.
 */
interface ProcessSpec {
  model: string;
  planMode: boolean;
  workingDir: string;
}

interface ChannelProcess {
  process: any;
  sessionId?: string;
  discordMessage: any;
  /** Undefined until the process is actually spawned (see reserveChannel). */
  spec?: ProcessSpec;
  /**
   * The session the CLI reports it is actually in, as opposed to the one we asked
   * for. Anything that repoints a channel at a different session (`/resume`,
   * `/adopt`, `/clear`) must not have its next prompt injected into a process
   * still holding the old conversation.
   */
  runningSessionId?: string;
  /** True between handing the CLI a prompt and that prompt's `result`. */
  turnActive: boolean;
  /** Background tasks the CLI reports as live, from `background_tasks_changed`. */
  liveTasks: Set<string>;
  /** Armed whenever the process is alive with no turn in flight. */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** Armed only while a turn is in flight — an idle process is not "hung". */
  inactivityTimer?: ReturnType<typeof setTimeout>;
  /** When the process was spawned, for the absolute background-task hold cap. */
  startedAt: number;
  /** Set while we're retiring the process, so `close` stays quiet about it. */
  shuttingDown?: boolean;
}

function sameSpec(a: ProcessSpec | undefined, b: ProcessSpec): boolean {
  return !!a && a.model === b.model && a.planMode === b.planMode && a.workingDir === b.workingDir;
}

// Substrings that mark a Claude/Anthropic API-layer failure (as opposed to a
// normal task failure). Matched case-insensitively. Kept deliberately specific
// so a model merely *discussing* API errors doesn't trigger the auto-retry.
const API_ERROR_MARKERS = [
  "connection closed mid-response",
  "api error",
  "unable to connect",
  "connection error",
  "overloaded",
  "internal server error",
  "request timed out",
  "econnreset",
  "etimedout",
];

export function isApiErrorText(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return API_ERROR_MARKERS.some((m) => t.includes(m));
}

// Escalating backoff for API-error auto-resume: 10s, 20s, 30s, 60s, then +60s
// each attempt, capped at 10 minutes — and it stays at 10 minutes forever after.
export function apiRetryDelayMs(attempt: number): number {
  const steps = [10, 20, 30, 60]; // seconds for attempts 0..3
  const sec = attempt < steps.length
    ? steps[attempt]!
    : Math.min(60 + (attempt - 3) * 60, 600);
  return sec * 1000;
}

// How often a held login is rechecked. The recheck is the held turn itself, so
// this is the cost of one CLI spawn — cheap enough to be frequent, and frequent
// enough that work resumes on its own shortly after `claude login`.
const AUTH_RETRY_MS = Number(process.env.AUTH_RETRY_SECONDS || 120) * 1000;

// Raw stream log. It records every byte of every turn's stdout, so it grows
// without bound — roll it at LOG_MAX_MB and keep one previous generation, which
// is enough to debug the run that just happened without ever eating the disk.
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_MB || 256) * 1024 * 1024;

export function appendStreamLog(text: string): void {
  const logPath = path.join(process.cwd(), "log.txt");
  try {
    // statSync per append is cheap next to the write itself, and checking before
    // writing is what keeps a single huge turn from blowing past the cap.
    let size = 0;
    try { size = fs.statSync(logPath).size; } catch {}
    if (size + text.length > LOG_MAX_BYTES) {
      try { fs.renameSync(logPath, `${logPath}.1`); } catch {}
      console.log(`Rotated log.txt at ${(size / 1024 / 1024).toFixed(0)} MB`);
    }
    fs.appendFileSync(logPath, text);
  } catch (error) {
    console.error("Error writing to log.txt:", error);
  }
}

function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelToolCalls = new Map<string, Map<string, { message: any, toolId: string }>>();
  private channelNames = new Map<string, string>();
  private channelModels = new Map<string, string>();
  // Model the in-flight run was launched with, so a newly reported session_id
  // is pinned to it (see getModelForRun / DatabaseManager.setSession).
  private channelRunModel = new Map<string, string>();
  // AskUserQuestion hang recovery:
  //   questionWatchdogs  — armed when answers go back to the CLI, cleared by any stdout.
  //   questionRecovery   — answers to replay as a prompt after killing a wedged turn.
  //   questionRecovered  — channels already recovered once this turn (recover at most once).
  private questionWatchdogs = new Map<string, NodeJS.Timeout>();
  private questionRecovery = new Map<string, string>();
  private questionRecovered = new Set<string>();
  // One long-lived CLI process per channel, reused across turns. It outlives the
  // turn that spawned it (see IDLE_KEEPALIVE_MS) so background watchers survive.
  private channelProcesses = new Map<string, ChannelProcess>();

  // Original user messages for reaction updates
  private originalMessages = new Map<string, any>();

  // Typing indicator intervals per channel
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Completion callback
  private onCompleteCallback?: OnCompleteCallback;
  /** Set by index.ts once the MCP server exists. See setPendingUserPromptProbe. */
  private pendingUserPrompt?: (channelId: string) => boolean;

  // Guard: only fire completion once per run
  private completionNotified = new Set<string>();

  // Task threads: channelId -> Map<toolId, thread>
  private channelTaskThreads = new Map<string, Map<string, any>>();

  // Discord context per channel (for user mentions)
  private channelDiscordContexts = new Map<string, DiscordContext>();

  // Working directory overrides (for worktree threads)
  private workingDirOverrides = new Map<string, string>();

  // Plan mode per channel
  private channelPlanMode = new Map<string, boolean>();

  // Thread -> parent channel mapping (for plan mode inheritance)
  private parentChannelMap = new Map<string, string>();

  // Context usage tracking: channels that have already been warned
  private contextWarned = new Set<string>();

  // --- Background-task (Monitor/watcher) tracking ---
  // Live task IDs are held per process (ChannelProcess.liveTasks), sourced from
  // the CLI's `background_tasks_changed` message — a full list, so it's
  // authoritative in a way that counting starts against terminal statuses isn't.
  //
  // Watcher notifications already surfaced to Discord, deduped per channel by the
  // notification's own uuid. Keyed on uuid rather than task id because a Monitor
  // watcher can legitimately fire many times over its life; deduping by task
  // would silently swallow every fire after the first.
  private notifiedTasks = new Map<string, Set<string>>();
  // Channels that have already posted an "init" embed for their current process.
  // The CLI re-emits `init` per turn once a session is running, and again for
  // each watcher-driven turn, so this is per process, not per turn.
  private initPosted = new Set<string>();

  // Channels whose process was spawned in streaming-input mode (stdin held open,
  // so prompts can be injected rather than respawned and background tasks live
  // past the turn). Raw `--` commands and image prompts are the exceptions.
  private streamingChannels = new Set<string>();

  // --- API-error auto-resume ---
  // When a run hits a Claude/Anthropic API error (connection dropped mid-response,
  // unable to connect, timed out, overloaded, …), we resume the session and retry
  // the turn — forever, with escalating backoff — until it completes without an
  // API error. See anthropics/claude-code#69415.
  //   apiErrorThisRun  — channels whose current run saw an API error (checked at close).
  //   apiRetryState    — per-channel backoff attempt counter + pending retry timer.
  //   lastRunParams    — exact params to relaunch a channel's turn on resume.
  private apiErrorThisRun = new Set<string>();
  private apiRetryState = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
  private lastRunParams = new Map<string, {
    channelName: string;
    prompt: string;
    discordContext?: DiscordContext;
    imageUrls?: string[];
  }>();

  // --- Account-level holds: plan limits and a dead login ---
  // Both arrive looking like an API error ("API Error: 429", "API Error: 401"),
  // so without this they fall into the backoff above — which is the wrong
  // interval for a limit that already told us when it lifts, and an unwinnable
  // loop for a login only a human can fix.
  //
  // They are held per *account*, not per channel, because that is what they are:
  // once one channel is refused, every other channel would be refused too, and
  // spawning them just burns a CLI each to rediscover the same answer.
  //   limitThisRun/authFailThisRun — this run's classification (checked at close).
  //   accountLimit                 — the current window, shared by every channel.
  //   authHold                     — set while the login is known to be broken.
  //   heldChannels                 — channels parked mid-turn, waiting on a hold.
  //   limitProbe                   — the one channel allowed out when a window ends.
  private limitThisRun = new Map<string, SessionLimit>();
  private authFailThisRun = new Map<string, string>();
  private accountLimit?: SessionLimit;
  private authHold?: { detail: string; since: number };
  private heldChannels = new Set<string>();
  private limitProbe?: string;

  private settings?: SettingsStore;
  private promptLinkConfig: PromptLinkConfig;

  constructor(private baseFolder: string, settings?: SettingsStore) {
    this.db = new DatabaseManager();
    this.settings = settings;
    this.promptLinkConfig = getPromptLinkConfig();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();

    // Load persisted settings
    if (settings) {
      const models = settings.getAllChannelModels();
      for (const [channelId, model] of Object.entries(models)) {
        this.channelModels.set(channelId, model);
      }
      const planModes = settings.getAllPlanModes();
      for (const [channelId, enabled] of Object.entries(planModes)) {
        this.channelPlanMode.set(channelId, enabled);
      }
      const dirOverrides = settings.getAllDirectoryOverrides();
      for (const [channelId, dir] of Object.entries(dirOverrides)) {
        this.workingDirOverrides.set(channelId, dir);
      }
    }
  }

  /**
   * Is this channel *busy* — a turn in flight, or about to be?
   *
   * Deliberately not "does a process exist": a channel's process now outlives its
   * turns, so process liveness stopped being a proxy for busy. An entry with no
   * process yet is a reservation (reserveChannel) and counts, and a channel
   * waiting out an API-error backoff has no process at all but is logically mid-turn.
   */
  hasActiveProcess(channelId: string): boolean {
    const entry = this.channelProcesses.get(channelId);
    if (entry && (entry.turnActive || !entry.process)) return true;
    return this.apiRetryState.has(channelId);
  }

  /** Is a CLI process alive for this channel, busy or merely being kept warm? */
  hasLiveProcess(channelId: string): boolean {
    return !!this.channelProcesses.get(channelId)?.process;
  }

  killActiveProcess(channelId: string): void {
    const wasRetrying = this.cancelApiRetry(channelId);
    // An explicit kill outranks question-hang recovery: don't resurrect the turn
    // the user just stopped.
    this.questionRecovery.delete(channelId);
    this.clearQuestionWatchdog(channelId);
    const activeProcess = this.channelProcesses.get(channelId);
    if (activeProcess?.process) {
      console.log(`Killing active process for channel ${channelId}`);
      this.stopTypingIndicator(channelId);
      this.clearProcessTimers(activeProcess);
      // Tree kill, not a bare signal: the CLI's own children (the MCP bridge
      // above all) would otherwise survive it. `close` still advances the queue.
      killProcessTree(activeProcess.process, "SIGTERM");
    } else if (wasRetrying) {
      // No live process, but we cancelled a pending retry — release the channel.
      console.log(`Cancelled pending API-error retry for channel ${channelId}`);
      this.stopTypingIndicator(channelId);
      this.channelProcesses.delete(channelId);
      this.notifyComplete(channelId, "failed");
    }
  }

  killAllProcesses(): number {
    let count = 0;
    for (const [channelId, entry] of this.channelProcesses) {
      if (entry.process) {
        console.log(`Killing process for channel ${channelId}`);
        this.stopTypingIndicator(channelId);
        this.questionRecovery.delete(channelId);
        this.clearQuestionWatchdog(channelId);
        this.clearProcessTimers(entry);
        killProcessTree(entry.process, "SIGTERM");
        count++;
      }
    }
    // Also cancel channels with no live process that are nonetheless mid-turn:
    // waiting on an API-error retry, or parked behind an account hold. Both own
    // a queue slot that only a completion releases.
    const waiting = new Set([...this.apiRetryState.keys(), ...this.heldChannels]);
    for (const channelId of waiting) {
      if (!this.channelProcesses.get(channelId)?.process && this.cancelApiRetry(channelId)) {
        this.stopTypingIndicator(channelId);
        this.channelProcesses.delete(channelId);
        this.notifyComplete(channelId, "failed");
        count++;
      }
    }
    // Nothing is left to release a hold, and the timers would fire into an empty
    // set. A killall is also the natural "start clean" gesture.
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.limitTimer = undefined;
    this.authTimer = undefined;
    this.accountLimit = undefined;
    this.authHold = undefined;
    this.limitProbe = undefined;
    return count;
  }

  clearSession(channelId: string): void {
    // Capture before the kill: we drop the process entry below, so `close` won't
    // be able to tell whether a turn was riding on it and can't release the queue
    // on our behalf. Clearing mid-turn has to do that release itself.
    const turnWasActive = this.hasActiveProcess(channelId);
    this.killActiveProcess(channelId);
    this.stopTypingIndicator(channelId);
    this.db.clearSession(channelId);
    this.channelMessages.delete(channelId);
    this.channelToolCalls.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
    this.originalMessages.delete(channelId);
    this.channelDiscordContexts.delete(channelId);
    this.workingDirOverrides.delete(channelId);
    this.contextWarned.delete(channelId);
    this.notifiedTasks.delete(channelId);
    this.initPosted.delete(channelId);
    this.streamingChannels.delete(channelId);
    this.cancelApiRetry(channelId);
    this.lastRunParams.delete(channelId);
    this.cleanupTaskThreads(channelId);
    if (turnWasActive) this.notifyComplete(channelId, "failed");
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelToolCalls.set(channelId, new Map());
  }

  setOriginalMessage(channelId: string, message: any): void {
    this.originalMessages.set(channelId, message);
  }

  getOriginalMessage(channelId: string): any {
    return this.originalMessages.get(channelId);
  }

  setWorkingDirOverride(channelId: string, workingDir: string): void {
    this.workingDirOverrides.set(channelId, workingDir);
  }

  setOnCompleteCallback(callback: OnCompleteCallback): void {
    this.onCompleteCallback = callback;
  }

  /**
   * Teach the hang reaper what "blocked on the user" looks like.
   *
   * A function rather than the PermissionManager itself: the permission side
   * already holds a reference to this manager (for question-answer recovery),
   * and handing it back would close the loop into a cycle for the sake of one
   * boolean. Optional, so the manager still works with no MCP server attached —
   * as it does in tests.
   */
  setPendingUserPromptProbe(probe: (channelId: string) => boolean): void {
    this.pendingUserPrompt = probe;
  }

  // `proc`, not `process`: the global is one careless rename away from a tree
  // kill aimed at the bot itself.
  private handleProcessTimeout(channelId: string, proc: any): void {
    console.log(`Claude process timed out (inactivity) for channel ${channelId}, killing it`);
    try { proc.kill("SIGTERM"); } catch {}

    const channel = this.channelMessages.get(channelId)?.channel;
    if (channel) {
      const timeoutEmbed = new EmbedBuilder()
        .setTitle("⏰ Timeout")
        .setDescription("Claude Code had no output for 10 minutes — process killed.")
        .setColor(0xFFD700);
      channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
    }

    // Guarantee the channel never hangs. Normally the `close` handler advances
    // the queue via notifyComplete, but SIGTERM can be ignored (wedged process)
    // or `close` can be delayed indefinitely if a grandchild keeps the stdio
    // pipe open. So escalate to SIGKILL, then — if `close` still hasn't fired —
    // force-advance the queue ourselves. notifyComplete is idempotent (guarded
    // by completionNotified), so a normal `close` in this window makes the
    // fallback a harmless no-op.
    setTimeout(() => killProcessTree(proc, "SIGKILL"), 10_000);

    setTimeout(() => {
      if (this.completionNotified.has(channelId)) return; // `close` already advanced us
      if (this.apiRetryState.has(channelId)) return; // an API-error retry is pending — leave it be
      console.error(
        `Reaper fallback for channel ${channelId}: process never closed after timeout kill — force-advancing queue`
      );
      this.channelProcesses.delete(channelId);
      this.streamingChannels.delete(channelId);
      this.notifyComplete(channelId, "failed");
    }, 20_000);
  }

  // --- Turn and process lifecycle ---
  //
  // A turn and a process are no longer the same thing. A turn runs from handing
  // the CLI a prompt to that prompt's `result`; the process outlives it, hosting
  // the session for the next prompt and — the reason any of this exists — for
  // background watchers that fire long after the turn ended.

  /** Mark the start of a turn on this channel's (already reserved) process. */
  private beginTurn(channelId: string, channelName: string): void {
    const entry = this.channelProcesses.get(channelId);
    if (!entry) return;
    if (entry.turnActive) return;
    entry.turnActive = true;
    this.clearIdleTimer(entry);
    this.db.markRunStarted(channelId, channelName);
    this.startTypingIndicator(channelId);
    this.armInactivityReaper(channelId);
  }

  /**
   * The turn's `result` landed. Release the channel and leave the process up.
   *
   * The queue used to be released at process close, precisely so a second process
   * couldn't be spawned for a channel while the first was still around. Now
   * "still around" is the normal state, so the release moves to the turn boundary
   * and the next prompt is injected into the same process instead.
   */
  private endTurn(channelId: string, status: CompletionStatus): void {
    const entry = this.channelProcesses.get(channelId);
    if (entry) {
      entry.turnActive = false;
      this.clearInactivityTimer(entry);
    }
    this.notifyComplete(channelId, status);
    this.armIdleShutdown(channelId);
  }

  private clearIdleTimer(entry: ChannelProcess): void {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined; }
  }

  private clearInactivityTimer(entry: ChannelProcess): void {
    if (entry.inactivityTimer) { clearTimeout(entry.inactivityTimer); entry.inactivityTimer = undefined; }
  }

  private clearProcessTimers(entry: ChannelProcess): void {
    this.clearIdleTimer(entry);
    this.clearInactivityTimer(entry);
  }

  /**
   * Start (or restart) the idle countdown on a process with no turn in flight.
   * Any output pushes it back, so a watcher-driven turn — which we never "began",
   * because no prompt of ours started it — isn't cut off half-way through.
   */
  private armIdleShutdown(channelId: string): void {
    const entry = this.channelProcesses.get(channelId);
    if (!entry?.process || entry.turnActive || entry.shuttingDown) return;
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => this.onIdleExpiry(channelId), IDLE_KEEPALIVE_MS);
  }

  private onIdleExpiry(channelId: string): void {
    const entry = this.channelProcesses.get(channelId);
    if (!entry?.process) return;
    if (entry.turnActive) return; // a turn started under us; endTurn re-arms

    const heldFor = Date.now() - entry.startedAt;
    if (entry.liveTasks.size > 0 && heldFor < MAX_TASK_HOLD_MS) {
      console.log(
        `Channel ${channelId} idle but holding ${entry.liveTasks.size} background task(s) — ` +
        `keeping the session process alive (held ${humanizeMs(heldFor)})`
      );
      entry.idleTimer = setTimeout(() => this.onIdleExpiry(channelId), IDLE_KEEPALIVE_MS);
      return;
    }
    if (entry.liveTasks.size > 0) {
      console.log(
        `Channel ${channelId} hit the ${humanizeMs(MAX_TASK_HOLD_MS)} background-task hold cap ` +
        `with ${entry.liveTasks.size} still live — retiring the session process anyway`
      );
    }
    void this.shutdownProcess(channelId, "idle");
  }

  /**
   * Retire a channel's process. stdin EOF is the front door: the CLI drains, tears
   * down its own background tasks and exits 0. SIGTERM is the escalation.
   *
   * Resolves once the process is actually gone, so a caller respawning for this
   * channel can't end up with two CLIs writing the same session transcript.
   */
  private shutdownProcess(channelId: string, reason: string): Promise<void> {
    const entry = this.channelProcesses.get(channelId);
    const proc = entry?.process;
    if (!entry || !proc) {
      if (entry) this.channelProcesses.delete(channelId);
      return Promise.resolve();
    }

    entry.shuttingDown = true;
    this.clearProcessTimers(entry);
    console.log(`Retiring session process for channel ${channelId} (${reason})`);

    return new Promise<void>((resolve) => {
      let settled = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let hardStop: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (escalation) clearTimeout(escalation);
        if (hardStop) clearTimeout(hardStop);
        if (this.channelProcesses.get(channelId)?.process === proc) {
          this.channelProcesses.delete(channelId);
        }
        resolve();
      };

      proc.once("close", finish);
      try { proc.stdin.end(); } catch {}

      escalation = setTimeout(() => {
        console.log(`Channel ${channelId} process ignored stdin EOF — escalating to SIGTERM`);
        try { proc.kill("SIGTERM"); } catch {}
        hardStop = setTimeout(() => {
          // Never resolve on a process that might still be alive: the caller's
          // next move is usually to spawn a replacement onto the same session.
          // By here it has declined both EOF and SIGTERM, so take the tree.
          killProcessTree(proc, "SIGKILL");
          finish();
        }, 3000);
      }, SHUTDOWN_GRACE_MS);
    });
  }

  /**
   * The no-output reaper, armed only while a turn is in flight. An idle process is
   * *supposed* to be silent, so silence is only evidence of a hang mid-turn.
   */
  private armInactivityReaper(channelId: string): void {
    const entry = this.channelProcesses.get(channelId);
    if (!entry?.process || !entry.turnActive) return;
    this.clearInactivityTimer(entry);
    entry.inactivityTimer = setTimeout(() => this.onInactivity(channelId), INACTIVITY_MS);
  }

  private onInactivity(channelId: string): void {
    const entry = this.channelProcesses.get(channelId);
    if (!entry?.process || !entry.turnActive) return;

    // Silence is only evidence of a hang if nothing is legitimately being waited
    // on. Two things are, and neither shows up as output:
    //
    // - a background task the turn is blocked on (`liveTasks`)
    // - the user, on a question or a tool approval. A multi-question
    //   AskUserQuestion hands each question its own fresh window, but the answers
    //   only reach the CLI once *all* of them are in, so stdout stays silent for
    //   the whole sitting — long enough, with a few questions, to be reaped while
    //   the question is still on screen waiting to be clicked.
    //
    // Both re-arm rather than reap, bounded by the same absolute hold cap so a
    // wait that never ends can't pin the process open forever.
    const waitingOn = entry.liveTasks.size > 0
      ? `${entry.liveTasks.size} background task(s)`
      : this.pendingUserPrompt?.(channelId)
        ? "the user"
        : undefined;

    if (waitingOn && Date.now() - entry.startedAt < MAX_TASK_HOLD_MS) {
      console.log(
        `Inactivity window elapsed in channel ${channelId} but it's waiting on ${waitingOn}; not reaping`
      );
      entry.inactivityTimer = setTimeout(() => this.onInactivity(channelId), INACTIVITY_MS);
      return;
    }
    this.handleProcessTimeout(channelId, entry.process);
  }

  private notifyComplete(channelId: string, status: CompletionStatus): void {
    if (this.completionNotified.has(channelId)) return;
    this.completionNotified.add(channelId);

    // The once-per-turn question-recovery guard is scoped to the turn that just
    // ended; the next one starts fresh.
    this.questionRecovered.delete(channelId);
    this.questionRecovery.delete(channelId);
    this.clearQuestionWatchdog(channelId);

    // Clear crash-recovery tracker
    this.db.markRunCompleted(channelId);

    this.stopTypingIndicator(channelId);

    const originalMessage = this.originalMessages.get(channelId);
    if (this.onCompleteCallback) {
      this.onCompleteCallback(channelId, status, originalMessage);
    }
  }

  // --- API-error auto-resume ---

  /**
   * Cancel a pending API-error retry (the wait between attempts). Returns true
   * if one was pending. Does NOT advance the queue — the caller decides that.
   */
  private cancelApiRetry(channelId: string): boolean {
    const state = this.apiRetryState.get(channelId);
    this.apiErrorThisRun.delete(channelId);
    this.limitThisRun.delete(channelId);
    this.authFailThisRun.delete(channelId);

    // A channel parked behind an account hold is waiting in exactly the same
    // sense as one between retries: no process, a held queue slot, and a run it
    // is owed. Stopping it has to release that too, or the slot never comes
    // back. The hold itself stays — it isn't this channel's to lift.
    const wasHeld = this.heldChannels.delete(channelId);
    if (this.limitProbe === channelId) this.limitProbe = undefined;

    if (!state) return wasHeld;
    if (state.timer) clearTimeout(state.timer);
    this.apiRetryState.delete(channelId);
    return true;
  }

  /**
   * Schedule the next API-error resume with escalating backoff. The queue stays
   * held (we never call notifyComplete), so no new turn starts underneath.
   */
  private scheduleApiRetry(channelId: string): void {
    const attempt = this.apiRetryState.get(channelId)?.attempt ?? 0;
    const delay = apiRetryDelayMs(attempt);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle("🔁 API error — auto-resuming")
        .setDescription(
          `Claude hit an API error. Resuming the session in **${humanizeMs(delay)}** ` +
          `(attempt ${attempt + 1}). I'll keep retrying until it goes through.`
        )
        .setColor(0xFFA500);
      channel.send({ embeds: [embed] }).catch(console.error);
    }

    const timer = setTimeout(() => this.retryTurn(channelId), delay);
    this.apiRetryState.set(channelId, { attempt: attempt + 1, timer });
  }

  /**
   * Relaunch a channel's turn by resuming its session. Called by the backoff
   * timer. The turn's outcome comes back through the normal stream/close path,
   * which re-detects any API error and schedules the next attempt.
   *
   * `promptOverride` replays something other than the original prompt — used by
   * question-hang recovery to resume with the answers the user already gave.
   */
  private retryTurn(channelId: string, promptOverride?: string): void {
    const params = this.lastRunParams.get(channelId);
    if (!params) {
      console.error(`retryTurn: no saved params for channel ${channelId}; giving up`);
      this.apiRetryState.delete(channelId);
      this.channelProcesses.delete(channelId);
      this.notifyComplete(channelId, "failed");
      return;
    }

    const sessionId = this.getSessionId(channelId);
    const discordMessage = this.channelMessages.get(channelId);
    // reserveChannel resets the completion guard so the resumed turn can complete.
    this.reserveChannel(channelId, sessionId, discordMessage);
    this.runClaudeCode(
      channelId, params.channelName, promptOverride ?? params.prompt, sessionId, params.discordContext, params.imageUrls
    ).catch((err) => {
      // A spawn/setup failure won't produce a `close`, so back off and retry here.
      console.error(`retryTurn: relaunch failed for channel ${channelId}:`, err);
      this.channelProcesses.delete(channelId);
      this.scheduleApiRetry(channelId);
    });
  }

  // --- Account-level holds: plan limits and a dead login ---

  /**
   * Read a piece of failure output for the two things that are not the work's
   * fault. Auth wins over a limit, which wins over the generic API error,
   * because a 401 body can mention both and only the narrowest reading leads
   * anywhere useful.
   *
   * Callers must only pass text already established to be a failure — a
   * synthetic assistant message, an error result, or stderr. Handing this
   * ordinary model prose would let Claude park the account by describing a rate
   * limit in a sentence.
   */
  private classifyFailure(channelId: string, text: string | undefined): void {
    if (!text) return;

    if (!this.authFailThisRun.has(channelId)) {
      const detail = detectAuthFailure(text);
      if (detail) {
        console.log(`Detected auth failure in channel ${channelId}: ${detail}`);
        this.authFailThisRun.set(channelId, detail);
        return;
      }
    }

    // A `rate_limit_event` already recorded for this run is exact; nothing read
    // out of prose should overwrite it.
    if (this.limitThisRun.has(channelId)) return;
    const limit = detectSessionLimit(text, Date.now());
    if (limit) {
      console.log(
        `Detected plan limit in channel ${channelId} (${limit.label}); ` +
        `resuming in ${humanizeMs(limit.resumeAt - Date.now())}`
      );
      this.limitThisRun.set(channelId, limit);
    }
  }

  /** Is the account inside a plan-limit window right now? */
  private limitActive(): boolean {
    if (!this.accountLimit) return false;
    if (Date.now() < this.accountLimit.resumeAt) return true;
    // The window has passed but nothing has proved it: leave it to the probe.
    return this.limitProbe !== undefined;
  }

  /**
   * Drop every account-level hold. Called when something proves the account is
   * fine — a turn completing is the only evidence that actually settles it.
   */
  private clearAccountHolds(why: string): void {
    if (!this.accountLimit && !this.authHold) return;
    console.log(`Clearing account holds (${why})`);
    this.accountLimit = undefined;
    this.authHold = undefined;
    this.limitProbe = undefined;
    // Anything parked behind the hold goes now. Released one at a time in the
    // order they were held, so a dozen channels don't all spawn at once.
    const waiting = [...this.heldChannels];
    this.heldChannels.clear();
    for (const held of waiting) this.retryTurn(held);
  }

  /**
   * A plan limit. Park this channel's turn and schedule it for the reset.
   *
   * The queue stays held — `notifyComplete` is deliberately not called — so the
   * prompt is waiting, not failed, and nothing new starts underneath it.
   */
  private holdForLimit(channelId: string, limit: SessionLimit): void {
    // Re-arming during a probe is expected: it means the limit had not really
    // lifted. Take the newer time rather than stacking windows.
    const first = this.accountLimit === undefined;
    if (this.limitProbe === channelId) this.limitProbe = undefined;
    // Announced-ness belongs to the *window*, not to the report that arrived.
    // A second channel hitting the same limit carries its own fresh
    // `announced: false`, and reading that would re-post the notice per channel.
    const announced = limit.announced === true || this.accountLimit?.announced === true;
    this.accountLimit = { ...limit, announced };

    const waitMs = Math.max(0, limit.resumeAt - Date.now());
    console.log(
      `Plan limit hit in channel ${channelId} (${limit.label}); ` +
      `holding every channel for ${humanizeMs(waitMs)}`
    );

    if (!announced) {
      this.announceHold(
        channelId,
        "⏳ Plan limit reached",
        `The account's **${limit.label}** is in effect. ` +
        (limit.resetsAtEpochSec ? `Resets <t:${limit.resetsAtEpochSec}:R>.` : `Retrying in ${humanizeMs(waitMs)}.`) +
        "\n\nYour prompt is held, not failed — I'll run it automatically then.",
        0xE74C3C,
      );
      this.accountLimit.announced = true;
    }

    this.parkChannel(channelId);
    if (first || !this.limitTimer) this.armLimitTimer();
  }

  /** One timer for the whole account, re-armed whenever the window moves. */
  private limitTimer?: ReturnType<typeof setTimeout>;

  private armLimitTimer(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    const limit = this.accountLimit;
    if (!limit) return;

    this.limitTimer = setTimeout(() => {
      this.limitTimer = undefined;
      if (!this.accountLimit) return;

      // One channel goes out first to find out whether the limit really lifted.
      // Releasing all of them would spend the entire held queue rediscovering
      // the same limit if the reset time was optimistic.
      const next = [...this.heldChannels][0];
      if (next === undefined) {
        this.accountLimit = undefined;
        return;
      }
      this.heldChannels.delete(next);
      this.limitProbe = next;
      console.log(`Plan limit window passed; probing with channel ${next}`);
      this.retryTurn(next);
    }, Math.max(0, limit.resumeAt - Date.now()));
  }

  /**
   * A login that has stopped working. Nothing here clears itself: the fix is a
   * human running `claude login` on this machine.
   *
   * So the prompt is held rather than failed, and the retry doubles as the
   * probe — a resumed turn either goes through, which proves the login is back,
   * or fails the same way and re-arms. That costs one cheap spawn every couple
   * of minutes and needs no separate health check.
   */
  private holdForAuth(channelId: string, detail: string): void {
    const first = this.authHold === undefined;
    this.authHold = { detail, since: this.authHold?.since ?? Date.now() };

    console.log(
      `Auth failure in channel ${channelId}: ${detail}; ` +
      `holding every channel, rechecking every ${humanizeMs(AUTH_RETRY_MS)}`
    );

    if (first) {
      this.announceHold(
        channelId,
        "🔒 Not logged in",
        `Claude Code can't authenticate — ${detail}.\n\n` +
        "**Run `claude login` on the machine running this bot.**\n\n" +
        `Your prompt is held, not failed; I'm rechecking every ${humanizeMs(AUTH_RETRY_MS)} ` +
        "and will pick it up as soon as the login works again.",
        0xE74C3C,
      );
    }

    this.parkChannel(channelId);
    if (!this.authTimer) this.armAuthTimer();
  }

  private authTimer?: ReturnType<typeof setTimeout>;

  private armAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      this.authTimer = undefined;
      if (!this.authHold) return;

      // Same single-probe shape as the limit: one channel tries, and either it
      // works (clearing the hold and releasing the rest) or it re-arms.
      const next = [...this.heldChannels][0];
      if (next === undefined) {
        this.authHold = undefined;
        return;
      }
      this.heldChannels.delete(next);
      console.log(`Rechecking login with channel ${next}`);
      this.retryTurn(next);
    }, AUTH_RETRY_MS);
  }

  /**
   * Park a channel whose turn is waiting on an account hold. Its queue slot and
   * `lastRunParams` are already held; this only records that it is owed a run.
   *
   * Deliberately does not touch `channelProcesses`. On the close path the entry
   * is already gone, and on the gate path the channel may still have a perfectly
   * good idle process from an earlier turn — dropping the entry there would
   * orphan it, leaving a CLI alive with nothing tracking it. Its own idle timer
   * retires it if the hold outlasts it.
   */
  private parkChannel(channelId: string): void {
    this.heldChannels.add(channelId);
  }

  private announceHold(channelId: string, title: string, description: string, color: number): void {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
    channel.send({ embeds: [embed] }).catch(console.error);
  }

  // --- AskUserQuestion hang recovery ---

  /**
   * Arm the post-answer watchdog. Called by the permission manager the moment
   * an AskUserQuestion's answers are handed back to the CLI over MCP.
   *
   * The wedge this exists for: the CLI receives the answers, the permission
   * response returns cleanly, and then the turn produces no further output at
   * all — the tool call never resolves, so nothing downstream ever fires. From
   * the bot's side it is indistinguishable from a very slow turn until the
   * 10-minute reaper finally kills it and the answers are lost.
   */
  noteQuestionAnswered(channelId: string, answersText: string): void {
    this.clearQuestionWatchdog(channelId);
    if (!this.channelProcesses.has(channelId)) return;
    const timer = setTimeout(
      () => this.handleQuestionHang(channelId, answersText),
      QUESTION_ANSWER_WATCHDOG_MS
    );
    this.questionWatchdogs.set(channelId, timer);
    console.log(
      `Question answers delivered for channel ${channelId}; watchdog armed for ` +
      `${humanizeMs(QUESTION_ANSWER_WATCHDOG_MS)}`
    );
  }

  /** Any output from the CLI means it isn't wedged — disarm. */
  private clearQuestionWatchdog(channelId: string): void {
    const timer = this.questionWatchdogs.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.questionWatchdogs.delete(channelId);
    }
  }

  /**
   * The watchdog fired: the turn is wedged on an answered question. Kill it and
   * mark the channel for recovery — `close` resumes the session with the answers
   * replayed as a normal message, so the work continues instead of being lost.
   *
   * Recovery runs at most once per turn. If the resumed turn wedges the same way
   * the second time, we let it fail normally rather than loop.
   */
  private handleQuestionHang(channelId: string, answersText: string): void {
    this.questionWatchdogs.delete(channelId);
    const entry = this.channelProcesses.get(channelId);
    if (!entry) return;

    const channel = this.channelMessages.get(channelId)?.channel;

    if (this.questionRecovered.has(channelId)) {
      console.error(
        `Channel ${channelId} wedged on an answered question again after recovery; not retrying`
      );
      if (channel) {
        channel.send({
          embeds: [new EmbedBuilder()
            .setTitle("⚠️ Stuck on question answers again")
            .setDescription(
              "The session wedged after answering a question a second time, so I stopped " +
              "auto-recovering. Send the answers as a normal message to continue."
            )
            .setColor(0xFF0000)],
        }).catch(console.error);
      }
      return;
    }

    console.log(`Channel ${channelId} produced no output ${humanizeMs(QUESTION_ANSWER_WATCHDOG_MS)} after ` +
      `question answers were delivered — killing and resuming with the answers`);
    this.questionRecovered.add(channelId);
    this.questionRecovery.set(channelId, answersText);

    if (channel) {
      channel.send({
        embeds: [new EmbedBuilder()
          .setTitle("🔁 Recovering the answered question")
          .setDescription(
            "Claude went silent after receiving your answers. Restarting the session and " +
            "replaying them so nothing is lost."
          )
          .setColor(0xFFA500)],
      }).catch(console.error);
    }

    try { entry.process.kill("SIGTERM"); } catch {}
    // SIGTERM can be ignored by a wedged process; escalate so `close` fires and
    // the recovery in the close handler actually runs.
    setTimeout(() => {
      if (this.channelProcesses.get(channelId)?.process === entry.process) {
        try { entry.process.kill("SIGKILL"); } catch {}
      }
    }, 5000);
  }

  /** The message replayed after a question hang, so Claude sees the answers again. */
  private buildQuestionReplayPrompt(answersText: string): string {
    return (
      "The session was interrupted while your last question was being answered, so the " +
      "answers never reached you. Here they are — continue the task with them in mind, " +
      "and do not ask the same questions again:\n\n" + answersText
    );
  }

  // --- Typing indicator ---

  private startTypingIndicator(channelId: string): void {
    this.stopTypingIndicator(channelId); // clear any existing
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Send typing immediately, then every 8 seconds
    channel.sendTyping().catch(() => {});
    const interval = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 8000);
    this.typingIntervals.set(channelId, interval);
  }

  private stopTypingIndicator(channelId: string): void {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }

  // --- Task threads ---

  private async createTaskThread(channelId: string, toolId: string, description: string): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    try {
      // Create a short name from the description
      const threadName = description.length > 90
        ? description.substring(0, 87) + "..."
        : description;

      const thread = await channel.threads.create({
        name: `Task: ${threadName}`,
        autoArchiveDuration: 60,
      });

      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("📋 Task Started")
            .setDescription(description)
            .setColor(0x5865F2),
        ],
      });

      if (!this.channelTaskThreads.has(channelId)) {
        this.channelTaskThreads.set(channelId, new Map());
      }
      this.channelTaskThreads.get(channelId)!.set(toolId, thread);
    } catch (error) {
      console.error("Error creating task thread:", error);
    }
  }

  private async postTaskResult(channelId: string, toolId: string, result: string, isError: boolean): Promise<void> {
    const threads = this.channelTaskThreads.get(channelId);
    const thread = threads?.get(toolId);
    if (!thread) return;

    try {
      const truncated = result.length > 1900
        ? result.substring(0, 1900) + "..."
        : result;

      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(isError ? "❌ Task Failed" : "✅ Task Complete")
            .setDescription(truncated)
            .setColor(isError ? 0xFF0000 : 0x00FF00),
        ],
      });
    } catch (error) {
      console.error("Error posting task result:", error);
    }
  }

  private cleanupTaskThreads(channelId: string): void {
    const threads = this.channelTaskThreads.get(channelId);
    if (!threads) return;

    for (const [, thread] of threads) {
      thread.delete().catch(() => {});
    }
    this.channelTaskThreads.delete(channelId);
  }

  reserveChannel(
    channelId: string,
    sessionId: string | undefined,
    discordMessage: any
  ): void {
    const existing = this.channelProcesses.get(channelId);
    if (existing) {
      // Point the existing process at the new turn rather than killing it. Killing
      // here is what used to take a session's background watchers down with it —
      // and it's unnecessary, since runClaudeCode either injects into this process
      // or retires it deliberately when the spawn args have to change.
      existing.sessionId = sessionId;
      existing.discordMessage = discordMessage;
    } else {
      // Reserve the channel with a placeholder entry (prevents race conditions).
      this.channelProcesses.set(channelId, {
        process: null, // Will be set when the process actually starts
        sessionId,
        discordMessage,
        turnActive: false,
        liveTasks: new Set(),
        startedAt: 0,
      });
    }

    // Reset completion guard for new run
    this.completionNotified.delete(channelId);
  }

  /**
   * Write a stream-json user message to a process's stdin. Used both for the
   * initial prompt of a streaming run and for mid-turn injections.
   */
  private writeUserMessage(process: any, text: string): boolean {
    if (!process?.stdin?.writable) return false;
    const message = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    }) + "\n";
    try {
      process.stdin.write(message);
      return true;
    } catch (error) {
      console.error("Error writing user message to stdin:", error);
      return false;
    }
  }

  /**
   * Inject a message into the running process's stdin while it works, the same
   * as typing in the CLI mid-turn. Returns false if there's no live streaming
   * process to inject into. `mode` only affects how the text is framed.
   */
  injectMessage(channelId: string, text: string, mode: "interrupt" | "btw" = "interrupt"): boolean {
    if (!this.streamingChannels.has(channelId)) return false;
    const entry = this.channelProcesses.get(channelId);
    const process = entry?.process;
    if (!process) return false;
    // Only mid-turn. The process is now kept alive between turns too, and writing
    // into an idle one would start a turn nothing is tracking — a plain message
    // is the way to start work, and it goes through the queue like everything else.
    if (!entry!.turnActive) return false;

    const content = mode === "btw"
      ? `By the way — a quick side question. Answer it briefly and then continue your current task without abandoning it: ${text}`
      : text;

    const ok = this.writeUserMessage(process, content);
    if (ok) {
      console.log(`Injected ${mode} message into channel ${channelId}`);
    }
    return ok;
  }

  /**
   * Gracefully stop the current turn by sending a `control_request`/`interrupt`
   * to the running process's stdin — the programmatic equivalent of pressing
   * Esc once in the interactive CLI. Claude aborts in-flight work cleanly and
   * emits a result, so the session is preserved (unlike SIGTERM via /kill).
   * Returns false if there's no process accepting input to interrupt.
   */
  interruptSession(channelId: string): boolean {
    const process = this.channelProcesses.get(channelId)?.process;
    if (!process?.stdin?.writable) {
      // No live process — but if we're between API-error retries, cancelling the
      // pending retry is the graceful stop the user is asking for.
      if (this.cancelApiRetry(channelId)) {
        this.stopTypingIndicator(channelId);
        this.channelProcesses.delete(channelId);
        this.notifyComplete(channelId, "failed");
        return true;
      }
      return false;
    }

    const message = JSON.stringify({
      type: "control_request",
      request_id: `interrupt_${Date.now()}`,
      request: { subtype: "interrupt" },
    }) + "\n";

    try {
      process.stdin.write(message);
      console.log(`Sent graceful interrupt (control_request) to channel ${channelId}`);
      return true;
    } catch (error) {
      console.error("Error sending interrupt control_request to stdin:", error);
      return false;
    }
  }

  /**
   * Stop a session process that has no turn in flight but is being held open for
   * background watchers — the "I've seen enough, stop waiting" case.
   *
   * Sends the interrupt first (in case the CLI is mid-way through a watcher-driven
   * turn of its own, which we never began and so don't count as active), then
   * retires the process. stdin EOF is the graceful door: the CLI tears its own
   * background tasks down and exits 0, and the session is preserved for the next
   * message, exactly as with a turn-level /stop.
   */
  async stopIdleSession(channelId: string): Promise<boolean> {
    const entry = this.channelProcesses.get(channelId);
    if (!entry?.process || entry.turnActive) return false;
    console.log(`Stopping idle session process for channel ${channelId} on request`);
    this.interruptSession(channelId);
    await this.shutdownProcess(channelId, "stopped by user");
    return true;
  }

  getSessionId(channelId: string): string | undefined {
    return this.db.getSession(channelId);
  }

  /** The full current-session row for a channel — everything /session reports. */
  getSessionInfo(channelId: string) {
    return this.db.getSessionInfo(channelId);
  }

  /** How many background tasks are live on this channel's process right now. */
  getLiveTaskCount(channelId: string): number {
    return this.channelProcesses.get(channelId)?.liveTasks.size ?? 0;
  }

  /**
   * The directory this channel's runs use, as far as the manager knows: a
   * worktree override, else BASE_FOLDER/<channel name> once a run has named it.
   * Undefined before the first run of the process's life.
   */
  getSessionWorkingDir(channelId: string): string | undefined {
    return this.getWorkingDir(channelId);
  }

  setSessionFromAdopt(channelId: string, sessionId: string, channelName: string): void {
    this.db.setSession(channelId, sessionId, channelName);
  }

  pauseSession(channelId: string, name: string): boolean {
    const sessionId = this.db.getSession(channelId);
    if (!sessionId) return false;
    // Carry the accumulated cost into the paused record so it isn't lost when
    // clearSession deletes the channel_sessions row.
    const cost = this.db.getChannelCostInfo(channelId)?.totalCostUsd ?? 0;
    // The pinned model lives on the channel_sessions row clearSession is about to
    // delete — carry it into the paused record so /resume restores it.
    const model = this.db.getSessionModel(channelId);
    this.db.pauseSession(channelId, name, sessionId, cost, true, model);
    this.clearSession(channelId);
    return true;
  }

  /**
   * Pause the current session under its own id and hand back everything the
   * naming run needs. Order matters: pauseSession -> clearSession drops the
   * channel_sessions row *and* the working-dir override (worktrees), so the
   * model and cwd are captured before the pause, not after.
   */
  autoPauseSession(
    channelId: string,
    channelName: string
  ): { sessionId: string; model: string; workingDir?: string } | undefined {
    const sessionId = this.db.getSession(channelId);
    if (!sessionId) return undefined;
    const model = this.getModelForRun(channelId);
    // Prefer the directory runs in this channel actually used (override, else the
    // name the last run was launched with) over the caller's guess.
    const workingDir =
      this.workingDirOverrides.get(channelId) ||
      path.join(this.baseFolder, this.channelNames.get(channelId) || channelName);
    if (!this.pauseSession(channelId, sessionId)) return undefined;
    // The pause stands either way, but don't hand back a cwd we can't spawn
    // into: an invalid cwd surfaces as ENOENT naming the *command*, not the
    // directory. No cwd means "paused, but skip the naming run".
    if (!fs.existsSync(workingDir)) {
      console.error(`Auto-pause: working directory does not exist, skipping naming run: ${workingDir}`);
      return { sessionId, model };
    }
    return { sessionId, model, workingDir };
  }

  renamePausedSession(channelId: string, oldName: string, newName: string): boolean {
    return this.db.renamePausedSession(channelId, oldName, newName);
  }

  resumeSession(channelId: string, name: string, channelName: string): boolean {
    const paused = this.db.getPausedSession(channelId, name);
    if (!paused || !paused.isResumable) return false;
    this.db.setSession(channelId, paused.sessionId, channelName, paused.sessionModel);
    // Keep the name: the paused row is about to be deleted, and a session parked
    // under its own id (auto-pause) never had a name worth reporting.
    if (name !== paused.sessionId) {
      this.db.setSessionResumedFrom(channelId, name);
    }
    // Restore the cost that accrued before pausing so the running total continues.
    if (paused.totalCostUsd > 0) {
      this.db.addSessionCost(channelId, paused.totalCostUsd);
    }
    this.db.deletePausedSession(channelId, name);
    return true;
  }

  /**
   * Archive the current session's cost as a non-resumable paused row before it's
   * cleared, so cleared spend still counts toward the grand total in /costreview.
   * Hidden from /resume (name = session id, is_resumable = 0).
   */
  archiveSessionCost(channelId: string): void {
    const info = this.db.getChannelCostInfo(channelId);
    if (info && info.totalCostUsd > 0) {
      this.db.pauseSession(channelId, info.sessionId, info.sessionId, info.totalCostUsd, false);
    }
  }

  getPausedSessions(channelId: string) {
    return this.db.getPausedSessions(channelId);
  }

  getResumableSessions(channelId: string) {
    return this.db.getResumableSessions(channelId);
  }

  getChannelCostInfo(channelId: string) {
    return this.db.getChannelCostInfo(channelId);
  }

  getInterruptedRuns(): { channelId: string; channelName: string; startedAt: number }[] {
    return this.db.getInterruptedRuns();
  }

  clearAllActiveRuns(): void {
    this.db.clearAllActiveRuns();
  }

  getAllSessions() {
    return this.db.getAllSessions();
  }

  // --- Transcript import passthrough (/online) ---
  getImportWatermark(channelId: string) {
    return this.db.getImportWatermark(channelId);
  }
  setImportWatermark(channelId: string, sessionId: string, lastUuid: string): void {
    this.db.setImportWatermark(channelId, sessionId, lastUuid);
  }

  // --- Todo passthrough ---
  addTodo(channelId: string, text: string, parentChannelId?: string) {
    return this.db.addTodo(channelId, text, parentChannelId);
  }
  getTodos(channelId: string) {
    return this.db.getTodos(channelId);
  }
  getChannelAndChildTodos(channelId: string) {
    return this.db.getChannelAndChildTodos(channelId);
  }
  completeTodo(id: number) {
    return this.db.completeTodo(id);
  }
  uncompleteTodo(id: number) {
    return this.db.uncompleteTodo(id);
  }
  clearCompletedTodos(channelId: string) {
    return this.db.clearCompletedTodos(channelId);
  }
  getPromptHistory(channelId: string, limit?: number) {
    return this.db.getPromptHistory(channelId, limit);
  }

  getPromptCount(channelId: string): number {
    return this.db.getPromptCount(channelId);
  }

  /** Every channel/thread with recorded history, for dashboard discovery. */
  getKnownScopeIds(): string[] {
    return this.db.getKnownScopeIds();
  }

  setModel(channelId: string, model: string): void {
    this.channelModels.set(channelId, model);
    this.settings?.setModel(channelId, model);
    // An explicit /model is a deliberate choice about the conversation in front
    // of the user, so it repins the session in flight too — not just the default
    // for the next one.
    if (this.db.getSession(channelId)) {
      this.db.setSessionModel(channelId, resolveModelAlias(model));
    }
  }

  /** The channel's default model for *new* sessions. */
  getModel(channelId: string): string {
    return this.channelModels.get(channelId) || DEFAULT_MODEL;
  }

  /**
   * The model a run should actually launch with.
   *
   * Models are pinned per session, not per channel: a session keeps the model it
   * was created with for its whole life, so moving the channel default never
   * switches a conversation mid-flight. Precedence:
   *
   *   1. the session's pinned model (set at creation, or by an explicit /model)
   *   2. LEGACY_SESSION_MODEL, for sessions created before pinning existed —
   *      they predate the current default and should resume on what they ran on
   *   3. the channel default (/model, else DEFAULT_MODEL) for a brand-new session
   *
   * Note the CLI's bare aliases ("opus", "sonnet") float to whatever that tier
   * currently points at, which is exactly what pinning is here to prevent — so
   * the defaults are full model IDs.
   */
  getModelForRun(channelId: string): string {
    const pinned = this.db.getSessionModel(channelId);
    if (pinned) return pinned;
    if (this.db.getSession(channelId)) return LEGACY_SESSION_MODEL;
    return resolveModelAlias(this.getModel(channelId));
  }

  setPlanMode(channelId: string, enabled: boolean): void {
    this.channelPlanMode.set(channelId, enabled);
    this.settings?.setPlanMode(channelId, enabled);
  }

  isPlanMode(channelId: string): boolean {
    // Check if this channel has an explicit plan mode setting
    if (this.channelPlanMode.has(channelId)) {
      return this.channelPlanMode.get(channelId)!;
    }
    // Fall back to parent channel's plan mode (thread inheritance)
    const parentId = this.parentChannelMap.get(channelId);
    if (parentId) {
      return this.channelPlanMode.get(parentId) || false;
    }
    return false;
  }

  setParentChannel(threadId: string, parentId: string): void {
    this.parentChannelMap.set(threadId, parentId);
  }

  togglePlanMode(channelId: string): boolean {
    const current = this.isPlanMode(channelId);
    this.setPlanMode(channelId, !current);
    return !current;
  }

  private getWorkingDir(channelId: string): string | undefined {
    const override = this.workingDirOverrides.get(channelId);
    if (override) return override;
    const channelName = this.channelNames.get(channelId);
    if (channelName) return path.join(this.baseFolder, channelName);
    return undefined;
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext,
    imageUrls?: string[]
  ): Promise<void> {
    // Remember exactly how to relaunch this turn, so an API-error auto-resume can
    // replay it verbatim. Start the run with a clean API-error flag.
    this.lastRunParams.set(channelId, { channelName, prompt, discordContext, imageUrls });
    this.apiErrorThisRun.delete(channelId);
    this.limitThisRun.delete(channelId);
    this.authFailThisRun.delete(channelId);

    // The account is refusing work, and it refuses it for every channel at once.
    // Spawning here would buy one more rejection and one more CLI; park instead.
    // The probe channel is exempt — finding out whether the hold has lifted is
    // the whole reason it was let through.
    const heldBy = this.authHold ? "auth" : this.limitActive() ? "limit" : undefined;
    if (heldBy && this.limitProbe !== channelId && !this.heldChannels.has(channelId)) {
      if (heldBy === "auth") {
        this.announceHold(
          channelId,
          "🔒 Not logged in",
          `Claude Code can't authenticate — ${this.authHold!.detail}. ` +
          "**Run `claude login` on the machine running this bot.**\n\n" +
          "This prompt is held and will run once the login works again.",
          0xE74C3C,
        );
      } else {
        const limit = this.accountLimit!;
        this.announceHold(
          channelId,
          "⏳ Plan limit reached",
          `The account's **${limit.label}** is still in effect. ` +
          (limit.resetsAtEpochSec
            ? `Resets <t:${limit.resetsAtEpochSec}:R>.`
            : `Retrying in ${humanizeMs(Math.max(0, limit.resumeAt - Date.now()))}.`) +
          "\n\nThis prompt is held and will run automatically then.",
          0xE74C3C,
        );
      }
      this.parkChannel(channelId);
      return;
    }

    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    if (discordContext) {
      this.channelDiscordContexts.set(channelId, discordContext);
    }
    const workingDir = this.workingDirOverrides.get(channelId) || path.join(this.baseFolder, channelName);
    console.log(`Running Claude Code in: ${workingDir}`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const model = this.getModelForRun(channelId);
    // Remember it so the session_id this run reports back gets pinned to the
    // model it actually ran on.
    this.channelRunModel.set(channelId, model);
    const planMode = this.isPlanMode(channelId);

    // Use streaming-input mode for normal text prompts so stdin stays open. That
    // buys three things: /interrupt and /btw can inject mid-turn, later prompts
    // reuse this process instead of paying for a `--resume`, and — the load-bearing
    // one — background watchers survive the turn instead of being torn down 5s
    // after its result. Raw CLI commands and image messages can't do any of it:
    // their content lives in argv (`--image`, bare CLI args), not in a stream-json
    // message, so they keep the legacy -p path with stdin closed.
    const streaming = !isRawCommand(prompt) && (!imageUrls || imageUrls.length === 0);
    const spec: ProcessSpec = { model, planMode, workingDir };

    // Reuse the channel's existing process when it can carry this turn. Anything
    // baked into argv at spawn — model, plan mode, cwd — has to match, or the turn
    // would silently run under the previous one's settings; and it has to be in
    // the session this turn is for, or the prompt lands in the wrong conversation.
    const live = this.channelProcesses.get(channelId);
    const canReuse = streaming
      && !!live?.process
      && !live.turnActive
      && !live.shuttingDown
      && sameSpec(live.spec, spec)
      && live.runningSessionId === sessionId;
    if (canReuse) {
      this.beginTurn(channelId, channelName);
      if (this.writeUserMessage(live.process, prompt)) {
        console.log(`Injected prompt into the live session process for channel ${channelId}`);
        return;
      }
      // stdin died under us — fall through and respawn rather than lose the turn.
      console.error(`Live process for channel ${channelId} refused input; respawning`);
    }

    // Retire whatever's there before spawning: two CLIs writing the same session
    // transcript at once would interleave the conversation.
    if (live?.process) {
      await this.shutdownProcess(channelId, sameSpec(live.spec, spec) ? "prompt needs a fresh process" : "spawn args changed");
      this.reserveChannel(channelId, sessionId, this.channelMessages.get(channelId));
    }

    if (streaming) {
      this.streamingChannels.add(channelId);
    } else {
      this.streamingChannels.delete(channelId);
    }

    const { command, args } = buildClaudeCommand(workingDir, prompt, sessionId, discordContext, model, imageUrls, planMode, streaming);
    console.log(`Running command: ${command} ${args.join(" ")}`);

    const claude = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workingDir,
      env: { ...process.env },
    });

    console.log(`Claude process spawned with PID: ${claude.pid}`);

    // Update the channel process tracking with actual process
    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = claude;
      channelProcess.spec = spec;
      channelProcess.startedAt = Date.now();
      channelProcess.liveTasks = new Set();
      channelProcess.shuttingDown = false;
    }
    // A fresh process gets a fresh "Session Started" embed and a fresh watcher
    // notification ledger.
    this.initPosted.delete(channelId);
    this.notifiedTasks.delete(channelId);

    this.beginTurn(channelId, channelName);

    if (streaming) {
      // Deliver the initial prompt as a stream-json user message and keep stdin
      // open so further messages can be injected while the turn runs.
      this.writeUserMessage(claude, prompt);
    } else {
      // Close stdin to signal we're not sending input
      claude.stdin.end();
    }

    // Add immediate listeners to debug
    claude.on("spawn", () => {
      console.log("Process successfully spawned");
    });

    claude.on("error", (error) => {
      console.error("Process spawn error:", error);
    });

    let buffer = "";

    claude.stdout.on("data", (data) => {
      // Output means the process is alive and doing something: push back whichever
      // clock is running — the mid-turn hang reaper, or the idle countdown. The
      // latter matters for watcher-driven turns, which we never "began" and so
      // would otherwise be racing a shutdown timer armed before they started.
      const entry = this.channelProcesses.get(channelId);
      if (entry?.turnActive) this.armInactivityReaper(channelId);
      else if (entry) this.armIdleShutdown(channelId);
      // Any output at all means the CLI digested the question answers and is
      // moving again — the post-answer watchdog has nothing to catch.
      this.clearQuestionWatchdog(channelId);
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);

      // Log all streamed output to log.txt
      appendStreamLog(`[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`);

      buffer += rawData;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            // Remember the session the CLI says it's actually in. It gates reusing
            // this process for the next prompt, so a channel repointed at another
            // session (/resume, /adopt) can't have its turn land in the old one.
            if (parsed.session_id) {
              const procEntry = this.channelProcesses.get(channelId);
              if (procEntry?.process === claude) procEntry.runningSessionId = parsed.session_id;
            }

            // Flag Claude/Anthropic API errors so the turn is auto-resumed on close.
            // Precise on purpose: only CLI-synthesized assistant messages
            // (model === "<synthetic>") and error-flagged results count, so a model
            // merely *discussing* API errors never triggers an infinite retry.
            {
              const p = parsed as any;
              const isSynthApiErr = p.type === "assistant"
                && p.message?.model === "<synthetic>"
                && isApiErrorText(JSON.stringify(p.message?.content ?? ""));
              const isResultApiErr = p.type === "result"
                && (p.is_error === true || (typeof p.subtype === "string" && p.subtype !== "success"))
                && isApiErrorText(JSON.stringify(p));
              if (isSynthApiErr || isResultApiErr) {
                if (!this.apiErrorThisRun.has(channelId)) {
                  console.log(`Detected API error in channel ${channelId} (${p.type}) — will auto-resume on close`);
                }
                this.apiErrorThisRun.add(channelId);
                // Same text, read again for the two failures that need a
                // different answer than "retry soon". Deliberately inside this
                // branch: it inherits the synthetic/error-result guard, so a
                // model *writing about* rate limits or expired tokens in
                // ordinary prose can never park the whole account.
                this.classifyFailure(channelId, JSON.stringify(p));
              } else if (p.type === "result" && p.subtype === "success" && p.is_error !== true) {
                // The turn finished cleanly. The CLI does its own transient retries
                // (e.g. "Unable to connect… Retrying" on stderr) and may recover on
                // its own — a success result means any earlier blip is moot, so don't
                // resume.
                this.apiErrorThisRun.delete(channelId);
                // Stronger evidence than anything a hold was built on: work is
                // going through right now, so the account is neither limited nor
                // logged out, whatever we concluded earlier.
                this.clearAccountHolds("a turn completed successfully");
              }
            }

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "user" && parsed.message.content) {
              this.handleToolResultMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "rate_limit_event") {
              this.handleRateLimitEvent(channelId, parsed).catch(console.error);
            } else if (parsed.type === "result") {
              // A result whose origin is a task notification belongs to a turn the
              // CLI started by itself, when a background watcher fired. Nobody is
              // waiting on it: no queue slot to release, no reaction to flip.
              const watcherTurn = parsed.origin?.kind === "task-notification";
              this.handleResultMessage(channelId, parsed, watcherTurn).then(() => {
                if (this.apiErrorThisRun.has(channelId)) {
                  // The turn died at the API layer. Retire the process so `close`
                  // can schedule the resume; the queue stays held until it lands.
                  const entry = this.channelProcesses.get(channelId);
                  if (entry) this.clearProcessTimers(entry);
                  try { claude.kill("SIGTERM"); } catch {}
                  return;
                }
                if (watcherTurn) {
                  this.armIdleShutdown(channelId);
                  return;
                }
                this.endTurn(channelId, parsed.subtype === "success" ? "success" : "partial");
              }).catch(console.error);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.handleInitMessage(channelId, parsed).catch(console.error);
              } else if (parsed.subtype === "background_tasks_changed") {
                // The authoritative live-task list. Everything that decides whether
                // to keep this process alive reads it.
                this.updateLiveTasks(channelId, parsed.tasks);
              } else if (
                parsed.subtype === "task_started" ||
                parsed.subtype === "task_notification" ||
                parsed.subtype === "task_updated"
              ) {
                this.handleTaskMessage(channelId, parsed).catch(console.error);
              }
              const channelName = this.channelNames.get(channelId) || "default";
              this.db.setSession(channelId, parsed.session_id, channelName, this.channelRunModel.get(channelId));
            }
          } catch (error) {
            console.error("Error parsing JSON:", error, "Line:", line);
          }
        }
      }
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      this.clearQuestionWatchdog(channelId);
      this.stopTypingIndicator(channelId);

      // Capture before teardown: whether a turn was riding on this process decides
      // whether anything downstream is owed a completion at all.
      const entry = this.channelProcesses.get(channelId);
      const ours = entry?.process === claude;
      const turnActive = ours ? entry!.turnActive : false;
      const deliberate = ours ? !!entry!.shuttingDown : false;
      // Only tear down channel state if this is still *the* process. A stale exit
      // (the entry already replaced, or dropped by /clear) must not wipe state
      // belonging to whatever took its place.
      if (ours) {
        this.clearProcessTimers(entry!);
        this.channelProcesses.delete(channelId);
        this.notifiedTasks.delete(channelId);
        this.initPosted.delete(channelId);
        this.streamingChannels.delete(channelId);
      }

      if (deliberate) {
        // We retired this process on purpose (idle, or its spawn args no longer
        // fit the next turn). Whoever asked for it owns what happens next — in
        // particular, a respawn is usually already waiting on this `close`, and
        // failing the turn here would release its queue slot out from under it.
        console.log(`Channel ${channelId} session process retired cleanly (code ${code})`);
        return;
      }

      // Question-hang recovery: this run was killed because it went silent after
      // an AskUserQuestion was answered. Resume the session replaying the answers
      // instead of finalizing the turn. Same shape as the API-error path below —
      // the queue stays held so no new turn starts underneath.
      const questionAnswers = this.questionRecovery.get(channelId);
      if (questionAnswers !== undefined) {
        this.questionRecovery.delete(channelId);
        this.apiErrorThisRun.delete(channelId);
        this.retryTurn(channelId, this.buildQuestionReplayPrompt(questionAnswers));
        return;
      }

      // Both account-level failures are checked before the generic API error,
      // because both also *look* like one and the generic handling is wrong for
      // each: a limit knows when it lifts, and a dead login never does.
      // Each keeps the queue held, exactly as the API-error path does.
      const authFailure = this.authFailThisRun.get(channelId);
      if (authFailure) {
        this.authFailThisRun.delete(channelId);
        this.apiErrorThisRun.delete(channelId);
        this.limitThisRun.delete(channelId);
        this.holdForAuth(channelId, authFailure);
        return;
      }

      const limit = this.limitThisRun.get(channelId);
      if (limit) {
        this.limitThisRun.delete(channelId);
        this.apiErrorThisRun.delete(channelId);
        this.holdForLimit(channelId, limit);
        return;
      }

      // API-error auto-resume: if this run hit an API error, don't finalize the
      // turn — schedule the next resume with escalating backoff. We intentionally
      // do NOT call notifyComplete, so the queue stays held and no new turn starts.
      if (this.apiErrorThisRun.has(channelId)) {
        this.apiErrorThisRun.delete(channelId);
        this.scheduleApiRetry(channelId);
        return;
      }
      // Clean end for this run — reset the backoff so the next independent API
      // error starts again at 10s.
      this.apiRetryState.delete(channelId);

      if (!turnActive) {
        // The process was between turns — idle, or hosting only background work.
        // Its turn already completed and released the queue, so there is nothing
        // to finalize and nothing to apologise for; the next prompt spawns afresh.
        if (!deliberate) {
          console.log(`Channel ${channelId} session process exited between turns (code ${code})`);
        }
        return;
      }

      // A turn was in flight and the process died under it. notifyComplete is
      // guarded, so if the result had already landed this is a harmless no-op.
      const turnSucceeded = this.completionNotified.has(channelId);
      this.notifyComplete(channelId, "failed");

      if (code !== 0 && code !== null && !turnSucceeded) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Claude Code Failed")
            .setDescription(`Process exited with code: ${code}`)
            .setColor(0xFF0000); // Red for error

          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // API connection errors ("Unable to connect to API… Retrying", resets,
      // timeouts) surface on stderr — flag them for auto-resume at close.
      if (isApiErrorText(stderrOutput)) {
        this.apiErrorThisRun.add(channelId);
      }

      // An expired token in particular usually never reaches a tidy result: the
      // CLI exits before it has one, so the only evidence is the last thing it
      // wrote here. Checking only the stream was the version that never fired.
      this.classifyFailure(channelId, stderrOutput);

      // If there's significant stderr output, send warning to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          // Truncate before building the embed. Claude API connection errors
          // ("Unable to connect to API… Retrying") can carry a long stack trace
          // that blows past Discord's 4096-char embed limit — an oversized embed
          // is rejected at send time and the message is lost entirely. We'd
          // rather show a trimmed warning than nothing.
          const trimmed = stderrOutput.trim();
          const description = trimmed.length > 1900
            ? trimmed.slice(0, 1900) + "\n…(truncated)"
            : trimmed;

          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Warning")
            .setDescription(description)
            .setColor(0xFFA500); // Orange for warnings

          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      this.stopTypingIndicator(channelId);

      // Clean up process tracking on error
      const entry = this.channelProcesses.get(channelId);
      if (entry?.process === claude) {
        this.clearProcessTimers(entry);
        this.channelProcesses.delete(channelId);
      }

      // Notify completion on error
      this.notifyComplete(channelId, "failed");

      // Send error to Discord
      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ Process Error")
          .setDescription(error.message)
          .setColor(0xFF0000); // Red for errors

        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async handleInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // The CLI emits `init` per turn once a session is running, and again for each
    // watcher-driven turn it starts by itself. Post the "Session Started" embed
    // once per *process*, which is what the user actually cares about.
    if (this.initPosted.has(channelId)) return;
    this.initPosted.add(channelId);

    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code Session Started")
      .setDescription(`**Working Directory:** ${parsed.cwd}\n**Model:** ${parsed.model}\n**Tools:** ${parsed.tools.length} available`)
      .setColor(0x00FF00); // Green for init

    try {
      await channel.send({ embeds: [initEmbed] });
    } catch (error) {
      console.error("Error sending init message:", error);
    }
  }

  /**
   * Report a rate-limit event to Discord, telling the user when it resets.
   */
  private async handleRateLimitEvent(channelId: string, parsed: any): Promise<void> {
    const info = parsed.rate_limit_info || {};
    // Only surface actual rejections (hitting the limit), not informational events.
    if (info.status !== "rejected") return;

    // The authoritative source: `resetsAt` is an exact instant, where the text
    // parsing in limits.ts is reading a clock face out of prose. Record it
    // before the embed, so the schedule survives a channel we can't post to.
    const limit = limitFromRateLimitEvent(parsed, Date.now());
    if (limit) this.limitThisRun.set(channelId, limit);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const typeLabels: Record<string, string> = {
      five_hour: "5-hour",
      seven_day: "7-day",
      daily: "daily",
    };
    const limitLabel = typeLabels[info.rateLimitType] || info.rateLimitType || "rate";

    // resetsAt is unix seconds — use Discord's timestamp markup so it renders in
    // the viewer's local time and as a live relative countdown.
    const resetsAt = info.resetsAt;
    const resetText = resetsAt
      ? `<t:${resetsAt}:F> (<t:${resetsAt}:R>)`
      : "unknown";

    const discordContext = this.channelDiscordContexts.get(channelId);
    const mention = discordContext ? `<@${discordContext.userId}>` : undefined;

    const embed = new EmbedBuilder()
      .setTitle("🚫 Rate Limit Hit")
      .setDescription(
        `The **${limitLabel}** limit was hit.\n**Resets:** ${resetText}` +
        (limit
          ? "\n\nYour prompt is held, not failed — I'll run it automatically when the " +
            "limit lifts. Other channels wait too, since the limit is on the account."
          : "")
      )
      .setColor(0xE74C3C);

    // This fires the moment the limit bites, which is well before the turn
    // closes. Claiming the announcement here keeps `noteLimit` from posting a
    // near-duplicate seconds later; the text-fallback path still gets one.
    if (limit) limit.announced = true;

    try {
      await channel.send({ content: mention, embeds: [embed] });
    } catch (error) {
      console.error("Error sending rate limit message:", error);
    }
  }

  /** True while one or more background tasks (Monitor, background shells) run. */
  hasActiveWatchers(channelId: string): boolean {
    return (this.channelProcesses.get(channelId)?.liveTasks.size ?? 0) > 0;
  }

  /**
   * Adopt the CLI's `background_tasks_changed` list wholesale. It's a full
   * snapshot, which makes it authoritative in a way that counting `task_started`
   * against terminal statuses never was — a status we don't recognise used to
   * strand a task in the set forever, holding the process open with it.
   */
  private updateLiveTasks(channelId: string, tasks: any): void {
    const entry = this.channelProcesses.get(channelId);
    if (!entry) return;
    const ids = new Set<string>(
      Array.isArray(tasks) ? tasks.map((t: any) => t?.task_id).filter(Boolean) : []
    );
    if (ids.size !== entry.liveTasks.size) {
      console.log(`Channel ${channelId}: ${ids.size} background task(s) live`);
    }
    entry.liveTasks = ids;
  }

  private readonly TERMINAL_TASK_STATUSES = new Set([
    "stopped", "killed", "completed", "failed", "error", "done",
  ]);

  /**
   * Handle a background-task lifecycle event: keep the live set honest (belt and
   * braces alongside `background_tasks_changed`) and surface notifications.
   */
  private async handleTaskMessage(channelId: string, parsed: any): Promise<void> {
    const taskId = parsed.task_id;
    if (!taskId) return;

    const entry = this.channelProcesses.get(channelId);

    if (parsed.subtype === "task_started") {
      entry?.liveTasks.add(taskId);
      console.log(`Background task started (${taskId}) in channel ${channelId}`);
      return;
    }

    // A user-facing notification — post it (deduped) to Discord. The CLI then
    // wakes itself for a follow-up turn, which streams in as normal output; this
    // embed is just the heads-up that something fired.
    if (parsed.subtype === "task_notification") {
      await this.postWatcherNotification(channelId, parsed);
    }

    const status: string | undefined = parsed.status || parsed.patch?.status;
    if (status && this.TERMINAL_TASK_STATUSES.has(status)) {
      entry?.liveTasks.delete(taskId);
    }
  }

  /**
   * Post a watcher's notification to Discord. Reads the task's output file (the
   * CLI hands us a path rather than inline content) and includes its tail.
   *
   * Deduped on the notification's own uuid, not the task id: a Monitor watcher
   * can legitimately fire many times over its life, and keying on the task would
   * silently swallow every fire after the first.
   */
  private async postWatcherNotification(channelId: string, parsed: any): Promise<void> {
    const taskId = parsed.task_id;
    if (!taskId) return;
    const notificationKey: string = parsed.uuid || `${taskId}:${parsed.status ?? ""}`;

    let notified = this.notifiedTasks.get(channelId);
    if (!notified) {
      notified = new Set<string>();
      this.notifiedTasks.set(channelId, notified);
    }
    if (notified.has(notificationKey)) return;

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    let body = "";
    if (parsed.output_file) {
      try {
        const raw = fs.readFileSync(parsed.output_file, "utf-8").trim();
        if (raw) body = raw.length > 1500 ? "…" + raw.slice(-1500) : raw;
      } catch {
        // Output file may not exist yet or be unreadable — fall back to summary.
      }
    }

    // Nothing meaningful to show — wait for a richer notification.
    if (!body && !parsed.summary) return;

    notified.add(notificationKey);

    const description = [parsed.summary, body && "```\n" + body + "\n```"]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4096);

    const embed = new EmbedBuilder()
      .setTitle("🔔 Watcher")
      .setDescription(description)
      .setColor(0x5865F2);

    // Deliberately no user @mention here — watchers can fire often and pinging
    // every time is noisy. The embed alone surfaces the notification.
    try {
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("Error sending watcher notification:", error);
    }
  }

  private async handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    // Check for images in the message
    const images = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "image")
      : [];

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    try {
      // If there's text content, send an assistant message
      if (content && content.trim()) {
        const assistantEmbed = new EmbedBuilder()
          .setTitle("💬 Claude")
          .setDescription(content)
          .setColor(this.isPlanMode(channelId) ? 0xE67E22 : 0x7289DA); // Orange for plan, blurple otherwise

        await channel.send({ embeds: [assistantEmbed] });

        // Detect and send any image file paths mentioned in the text
        await this.detectAndSendImagePaths(channelId, content);
      }

      // Send images if present
      for (const image of images) {
        await this.sendImageToDiscord(channelId, image);
      }

      // If there are tool uses, send a message for each tool
      for (const tool of toolUses) {
        // Detect Task tool — create a Discord thread for it
        if (tool.name === "Task") {
          const taskDescription = tool.input?.prompt || tool.input?.description || "Running task...";
          await this.createTaskThread(channelId, tool.id, taskDescription);
        }

        let toolMessage = `🔧 ${tool.name}`;

        if (tool.input && Object.keys(tool.input).length > 0) {
          const inputs = Object.entries(tool.input)
            .map(([key, value]) => {
              let val = String(value);
              // Replace base folder path with relative path
              const basePath = this.getWorkingDir(channelId);
              if (basePath) {
                if (val === basePath) {
                  val = ".";
                } else if (val.startsWith(basePath + path.sep)) {
                  val = val.replace(basePath + path.sep, "./");
                }
              }
              return `${key}=${val}`;
            })
            .join(", ");
          toolMessage += ` (${inputs})`;
        }

        const toolEmbed = new EmbedBuilder()
          .setDescription(`⏳ ${toolMessage}`)
          .setColor(this.isPlanMode(channelId) ? 0xE67E22 : 0x0099FF); // Orange for plan, blue otherwise

        const sentMessage = await channel.send({ embeds: [toolEmbed] });

        // Track this tool call message for later updating
        toolCalls.set(tool.id, {
          message: sentMessage,
          toolId: tool.id
        });
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName, this.channelRunModel.get(channelId));
      this.channelToolCalls.set(channelId, toolCalls);

      // Check context window usage and warn if getting full
      await this.checkContextUsage(channelId, parsed.message);
    } catch (error) {
      console.error("Error sending assistant message:", error);
    }
  }

  private static readonly CONTEXT_WINDOW_TOKENS = 200_000;
  private static readonly CONTEXT_WARNING_THRESHOLD = 0.80;

  private async checkContextUsage(channelId: string, message: any): Promise<void> {
    if (this.contextWarned.has(channelId)) return;

    const inputTokens = message?.usage?.input_tokens;
    if (!inputTokens) return;

    const pct = inputTokens / ClaudeManager.CONTEXT_WINDOW_TOKENS;
    if (pct < ClaudeManager.CONTEXT_WARNING_THRESHOLD) return;

    this.contextWarned.add(channelId);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const used = Math.round(inputTokens / 1000);
    const total = Math.round(ClaudeManager.CONTEXT_WINDOW_TOKENS / 1000);
    const pctDisplay = Math.round(pct * 100);

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Context window filling up")
      .setDescription(
        `**${pctDisplay}%** used (${used}k / ${total}k tokens)\n\n` +
        `Run \`-claude /compact\` to free up space, or \`/clear\` to start fresh.`
      )
      .setColor(0xFFA500);

    try {
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to send context warning:", error);
    }
  }

  private async handleToolResultMessage(channelId: string, parsed: any): Promise<void> {
    const toolResults = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    if (toolResults.length === 0) return;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    for (const result of toolResults) {
      // Post result to task thread if this was a Task tool
      const threads = this.channelTaskThreads.get(channelId);
      if (threads?.has(result.tool_use_id)) {
        await this.postTaskResult(channelId, result.tool_use_id, result.content, result.is_error === true);
      }

      // Tool result content can be a string or an array of content blocks
      const resultContent = result.content;
      let textContent = "";
      let imageBlocks: any[] = [];

      if (typeof resultContent === "string") {
        textContent = resultContent;
      } else if (Array.isArray(resultContent)) {
        // Extract text and image blocks from array content
        for (const block of resultContent) {
          if (block.type === "text") {
            textContent += (textContent ? "\n" : "") + block.text;
          } else if (block.type === "image") {
            imageBlocks.push(block);
          }
        }
      }

      const toolCall = toolCalls.get(result.tool_use_id);
      if (toolCall && toolCall.message) {
        try {
          // Get the first line of the result
          const firstLine = (textContent.split('\n')[0] || "").trim();
          const resultText = firstLine.length > 100
            ? firstLine.substring(0, 100) + "..."
            : firstLine;

          // Get the current embed and update it
          const currentEmbed = toolCall.message.embeds[0];
          const originalDescription = currentEmbed.data.description.replace("⏳", "✅");
          const isError = result.is_error === true;

          const updatedEmbed = new EmbedBuilder();

          if (isError) {
            updatedEmbed
              .setDescription(`❌ ${originalDescription.substring(2)}\n*${resultText}*`)
              .setColor(0xFF0000); // Red for errors
          } else {
            updatedEmbed
              .setDescription(`${originalDescription}\n*${resultText}*`)
              .setColor(0x00FF00); // Green for completed
          }

          await toolCall.message.edit({ embeds: [updatedEmbed] });
        } catch (error) {
          console.error("Error updating tool result message:", error);
        }
      }

      // Send any image content blocks from the tool result (e.g. screenshots)
      for (const image of imageBlocks) {
        await this.sendImageToDiscord(channelId, image);
      }

      // Detect and send any image file paths mentioned in the text result
      if (textContent) {
        await this.detectAndSendImagePaths(channelId, textContent);
      }
    }
  }

  /**
   * A turn finished. `watcherTurn` marks the ones the CLI started by itself after
   * a background watcher fired: they carry no prompt of the user's, so they're
   * reported differently and are never charged against the last prompt.
   */
  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" },
    watcherTurn = false
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName, this.channelRunModel.get(channelId));

    if (watcherTurn) {
      await this.reportWatcherTurn(channelId, parsed);
      return;
    }

    // Persist summary for /status dashboard
    const summary = parsed.subtype === "success" && "result" in parsed ? parsed.result : `Failed: ${parsed.subtype}`;
    this.db.updateSessionSummary(channelId, summary, parsed.total_cost_usd, parsed.num_turns);

    // Prompt/result accounting. Dedupe on the prompt's message id so a duplicate
    // "complete" (which can arrive with watchers/streaming) doesn't double-count
    // the running total or duplicate history.
    const userMsg = this.originalMessages.get(channelId);
    const prompt = userMsg?.content || "unknown";
    const promptMessageId: string | undefined = userMsg?.id;
    const requestCost = parsed.total_cost_usd ?? 0;
    const alreadyCounted = promptMessageId ? this.db.hasPromptCost(promptMessageId) : false;

    let totalCost: number;
    if (alreadyCounted) {
      totalCost = this.db.getChannelCostInfo(channelId)?.totalCostUsd ?? requestCost;
    } else {
      totalCost = this.db.addSessionCost(channelId, requestCost);
      this.db.addPromptHistory(channelId, prompt, summary);
      // Record synchronously here (before any await) so a concurrent duplicate
      // complete sees it via hasPromptCost and doesn't double-count. The result
      // message id is filled in after we send below.
      if (promptMessageId) {
        try {
          this.db.recordPromptCost({
            promptMessageId,
            channelId,
            sessionId: parsed.session_id,
            promptText: typeof prompt === "string" ? prompt.slice(0, 2000) : undefined,
            costUsd: requestCost,
            numTurns: parsed.num_turns,
            createdAt: Date.now(),
          });
        } catch (error) {
          console.error("Error recording prompt cost:", error);
        }
      }
    }

    this.stopTypingIndicator(channelId);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Build user mention
    const discordContext = this.channelDiscordContexts.get(channelId);
    const mention = discordContext ? `<@${discordContext.userId}>` : "";

    // Create a final result embed
    const resultEmbed = new EmbedBuilder();
    const success = parsed.subtype === "success";
    const planMode = this.isPlanMode(channelId);

    const EMBED_LIMIT = 4096;
    let fileAttachment: AttachmentBuilder | undefined;

    if (success) {
      let description = "result" in parsed ? parsed.result : "Task completed";
      const costLine = `\n💰 This request: $${requestCost.toFixed(4)} · Session total: $${totalCost.toFixed(4)}`;
      const suffix = `\n\n*Completed in ${parsed.num_turns} turns*${costLine}`;

      if (description.length + suffix.length > EMBED_LIMIT) {
        // Attach full response as a file and truncate embed description
        fileAttachment = new AttachmentBuilder(Buffer.from(description, "utf-8"), { name: "response.md" });
        description = description.slice(0, EMBED_LIMIT - suffix.length - 40) + "\n\n*(truncated — see attached file)*";
      }

      description += suffix;

      resultEmbed
        .setTitle(planMode ? "📋 Plan Complete" : "✅ Session Complete")
        .setDescription(description)
        .setColor(planMode ? 0x9B59B6 : 0x00FF00); // Purple for plan, green for success
    } else {
      resultEmbed
        .setTitle("❌ Session Failed")
        .setDescription(`Task failed: ${parsed.subtype}`)
        .setColor(0xFF0000); // Red for failure
    }

    // Completion (and the queue release with it) is the caller's job — see
    // endTurn. It used to fire from here so the close handler couldn't race it,
    // but the process no longer closes at the end of a turn, so there's nothing
    // left to race and the release belongs at the turn boundary proper.

    // Add prompt link to result embed
    const originalMsg = this.originalMessages.get(channelId);
    if (this.promptLinkConfig.enabled && originalMsg) {
      const promptUrl = `https://discord.com/channels/${originalMsg.guildId}/${originalMsg.channelId}/${originalMsg.id}`;
      resultEmbed.addFields({ name: "Prompt", value: `[Jump to prompt](${promptUrl})` });
    }

    let resultMessage: any;
    try {
      resultMessage = await channel.send({
        content: mention || undefined,
        embeds: [resultEmbed],
        files: fileAttachment ? [fileAttachment] : [],
      });
    } catch (error) {
      console.error("Error sending result message:", error);
    }

    // Link the completion message to the prompt's cost record (best-effort).
    if (promptMessageId && resultMessage?.id && !alreadyCounted) {
      try {
        this.db.setPromptResultMessage(promptMessageId, resultMessage.id);
      } catch (error) {
        console.error("Error linking prompt result message:", error);
      }
    }

    console.log("Got result message, cleaning up process tracking");
  }

  /**
   * Report a turn the CLI ran on its own after a background watcher fired.
   *
   * It isn't a prompt, so it gets no `prompt_costs` row (the dashboard's prompt
   * count means "prompts that finished", and this finished without one) and it
   * never touches the last prompt's reactions or queue slot. Its spend is real,
   * though, so it still lands on the session total.
   *
   * Frequently there's nothing to say — the CLI acknowledges a notification with
   * an empty zero-turn result — and a "Session Complete" embed for that is pure
   * noise, so those are dropped.
   */
  private async reportWatcherTurn(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    const cost = parsed.total_cost_usd ?? 0;
    if (cost > 0) this.db.addSessionCost(channelId, cost);

    const text = ("result" in parsed && typeof parsed.result === "string" ? parsed.result : "").trim();
    console.log(`Watcher-driven turn completed in channel ${channelId} (${parsed.num_turns} turns, $${cost.toFixed(4)})`);
    if (!text) return;

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const EMBED_LIMIT = 4096;
    const suffix = `\n\n*Watcher follow-up · ${parsed.num_turns} turn${parsed.num_turns === 1 ? "" : "s"} · $${cost.toFixed(4)}*`;
    let description = text;
    let fileAttachment: AttachmentBuilder | undefined;
    if (description.length + suffix.length > EMBED_LIMIT) {
      fileAttachment = new AttachmentBuilder(Buffer.from(description, "utf-8"), { name: "watcher-response.md" });
      description = description.slice(0, EMBED_LIMIT - suffix.length - 40) + "\n\n*(truncated — see attached file)*";
    }

    const embed = new EmbedBuilder()
      .setTitle("🔔 Watcher — Claude followed up")
      .setDescription(description + suffix)
      .setColor(0x5865F2);

    // The user isn't necessarily looking at the channel — a watcher firing is
    // exactly the case where a mention is warranted, unlike the raw notification.
    const discordContext = this.channelDiscordContexts.get(channelId);
    try {
      await channel.send({
        content: discordContext ? `<@${discordContext.userId}>` : undefined,
        embeds: [embed],
        files: fileAttachment ? [fileAttachment] : [],
      });
    } catch (error) {
      console.error("Error sending watcher follow-up message:", error);
    }
  }

  /**
   * Send an image to Discord channel
   */
  private async sendImageToDiscord(channelId: string, imageContent: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    try {
      // Handle different image types
      if (imageContent.source?.type === "base64") {
        // Base64 encoded image
        const buffer = Buffer.from(imageContent.source.data, "base64");
        const ext = imageContent.source.media_type?.split("/")[1] || "png";
        const attachment = new AttachmentBuilder(buffer, { name: `image.${ext}` });

        await channel.send({
          content: "🖼️ **Image:**",
          files: [attachment]
        });
      } else if (imageContent.source?.type === "url") {
        // URL image
        await channel.send({
          content: "🖼️ **Image:**",
          embeds: [new EmbedBuilder().setImage(imageContent.source.url)]
        });
      }
    } catch (error) {
      console.error("Error sending image to Discord:", error);
    }
  }

  /**
   * Detect and send image file paths mentioned in text
   */
  private async detectAndSendImagePaths(channelId: string, text: string): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const workingDir = this.getWorkingDir(channelId);
    if (!workingDir) return;

    // Common image extensions
    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

    // Pattern to match file paths (both absolute and relative)
    const pathPattern = /(?:\.\/|\.\.\/|[A-Za-z]:[\\\/])?[\w\-\.\/\\]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi;
    const matches = text.match(pathPattern);

    if (!matches) return;

    const sentPaths = new Set<string>();

    for (const match of matches) {
      // Resolve to absolute path
      let imagePath = path.isAbsolute(match)
        ? match
        : path.join(workingDir, match);

      // Normalize path
      imagePath = path.normalize(imagePath);

      // Skip if already sent
      if (sentPaths.has(imagePath)) continue;

      // Check if file exists
      if (!fs.existsSync(imagePath)) continue;

      // Check if it's actually an image file
      const ext = path.extname(imagePath).toLowerCase();
      if (!imageExtensions.includes(ext)) continue;

      try {
        const attachment = new AttachmentBuilder(imagePath);
        await channel.send({
          content: `🖼️ **${path.basename(imagePath)}**`,
          files: [attachment]
        });
        sentPaths.add(imagePath);
      } catch (error) {
        console.error(`Error sending image ${imagePath}:`, error);
      }
    }
  }

  /**
   * Retire every live CLI process through the front door and wait for them.
   *
   * This is the difference between stopping the bot and abandoning it. Each
   * process gets stdin EOF, which lets the CLI drain, tear down its own
   * background tasks and reap its own children — so nothing is left holding a
   * socket to a permission server that's about to disappear. `shutdownProcess`
   * already owns the escalation ladder (EOF → SIGTERM → tree kill), so the
   * worst case here is bounded, and they run concurrently rather than one
   * eight-second grace period after another.
   */
  async shutdownAll(reason = "bot shutting down"): Promise<number> {
    const live = [...this.channelProcesses.entries()].filter(([, e]) => e.process);
    if (live.length === 0) return 0;

    console.log(`Retiring ${live.length} session process(es): ${reason}`);
    for (const [channelId] of live) {
      this.stopTypingIndicator(channelId);
      this.clearQuestionWatchdog(channelId);
      this.questionRecovery.delete(channelId);
    }
    await Promise.all(live.map(([channelId]) => this.shutdownProcess(channelId, reason)));
    return live.length;
  }

  // Clean up resources
  destroy(): void {
    // Stop all typing indicators
    for (const [channelId] of this.typingIntervals) {
      this.stopTypingIndicator(channelId);
    }

    // Close all active processes
    for (const [channelId] of this.channelProcesses) {
      this.killActiveProcess(channelId);
    }

    // Cancel any pending API-error retries (channels with no live process).
    for (const channelId of [...this.apiRetryState.keys()]) {
      this.cancelApiRetry(channelId);
    }

    // Account holds outlive every process by design, so their timers are the one
    // thing left that could keep the event loop alive after everything else is
    // torn down.
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.limitTimer = undefined;
    this.authTimer = undefined;

    // Close database connection
    this.db.close();
  }
}
