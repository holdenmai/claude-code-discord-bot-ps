import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { SDKMessage, CompletionStatus, PromptLinkConfig } from "../types/index.js";
import { getPromptLinkConfig } from "../types/index.js";
import { buildClaudeCommand, isRawCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager } from "../db/database.js";
import type { SettingsStore } from "../settings/settings-store.js";

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
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();

  // Original user messages for reaction updates
  private originalMessages = new Map<string, any>();

  // Typing indicator intervals per channel
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Completion callback
  private onCompleteCallback?: OnCompleteCallback;

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
  // Active watcher task IDs per channel. A turn's `result` no longer ends the
  // process while this set is non-empty; the CLI keeps it alive to deliver
  // watcher notifications.
  private channelWatchers = new Map<string, Set<string>>();
  // Channels whose turn produced a `result` while watchers were still running.
  private resultSeen = new Set<string>();
  // Completion status deferred until process close (watcher-holding runs), so we
  // don't advance the queue — and spawn a second process — while a watcher is live.
  private pendingCompletion = new Map<string, CompletionStatus>();
  // Watcher notifications already surfaced to Discord (dedupe): channelId -> task IDs.
  private notifiedTasks = new Map<string, Set<string>>();
  // Channels that have already posted an "init" embed (guards duplicate inits).
  private initPosted = new Set<string>();

  // Channels whose process was spawned in streaming-input mode (stdin held open
  // so messages can be injected mid-turn via /interrupt and /btw).
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

  hasActiveProcess(channelId: string): boolean {
    // A channel awaiting an API-error retry has no live process but is logically
    // still busy — report it as active so /kill and /stop can cancel the loop.
    return this.channelProcesses.has(channelId) || this.apiRetryState.has(channelId);
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
      activeProcess.process.kill("SIGTERM"); // `close` advances the queue
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
        entry.process.kill("SIGTERM");
        count++;
      }
    }
    // Also cancel channels waiting on an API-error retry (no live process).
    for (const channelId of [...this.apiRetryState.keys()]) {
      if (!this.channelProcesses.get(channelId)?.process && this.cancelApiRetry(channelId)) {
        this.stopTypingIndicator(channelId);
        this.channelProcesses.delete(channelId);
        this.notifyComplete(channelId, "failed");
        count++;
      }
    }
    return count;
  }

  clearSession(channelId: string): void {
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
    this.channelWatchers.delete(channelId);
    this.resultSeen.delete(channelId);
    this.pendingCompletion.delete(channelId);
    this.notifiedTasks.delete(channelId);
    this.initPosted.delete(channelId);
    this.streamingChannels.delete(channelId);
    this.cancelApiRetry(channelId);
    this.lastRunParams.delete(channelId);
    this.cleanupTaskThreads(channelId);
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

  private handleProcessTimeout(channelId: string, process: any): void {
    console.log(`Claude process timed out (inactivity) for channel ${channelId}, killing it`);
    try { process.kill("SIGTERM"); } catch {}

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
    setTimeout(() => {
      try { process.kill("SIGKILL"); } catch {}
    }, 10_000);

    setTimeout(() => {
      if (this.completionNotified.has(channelId)) return; // `close` already advanced us
      if (this.apiRetryState.has(channelId)) return; // an API-error retry is pending — leave it be
      console.error(
        `Reaper fallback for channel ${channelId}: process never closed after timeout kill — force-advancing queue`
      );
      this.channelProcesses.delete(channelId);
      this.streamingChannels.delete(channelId);
      this.channelWatchers.delete(channelId);
      this.resultSeen.delete(channelId);
      this.pendingCompletion.delete(channelId);
      this.notifyComplete(channelId, "failed");
    }, 20_000);
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
    if (!state) return false;
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
    // Kill any existing process (safety measure)
    const existingProcess = this.channelProcesses.get(channelId);
    if (existingProcess?.process) {
      console.log(
        `Killing existing process for channel ${channelId} before starting new one`
      );
      existingProcess.process.kill("SIGTERM");
    }

    // Reserve the channel by adding a placeholder entry (prevents race conditions)
    this.channelProcesses.set(channelId, {
      process: null, // Will be set when process actually starts
      sessionId,
      discordMessage,
    });

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
    const process = this.channelProcesses.get(channelId)?.process;
    if (!process) return false;

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

  getSessionId(channelId: string): string | undefined {
    return this.db.getSession(channelId);
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

  resumeSession(channelId: string, name: string, channelName: string): boolean {
    const paused = this.db.getPausedSession(channelId, name);
    if (!paused || !paused.isResumable) return false;
    this.db.setSession(channelId, paused.sessionId, channelName, paused.sessionModel);
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

    // Use streaming-input mode for normal text prompts so stdin stays open and
    // /interrupt and /btw can inject messages mid-turn. Raw CLI commands and
    // image messages keep the legacy -p path (stdin closed).
    const streaming = !isRawCommand(prompt) && (!imageUrls || imageUrls.length === 0);
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

    // Track this run for crash recovery
    this.db.markRunStarted(channelId, channelName);

    // Update the channel process tracking with actual process
    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = claude;
    }

    // Start typing indicator
    this.startTypingIndicator(channelId);

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

    // Inactivity timeout: kill if no stdout for 10 minutes (resets on each output).
    // Long / slow API turns can go quiet for minutes at a time — especially when
    // Anthropic is overloaded — so keep this generous to avoid reaping a turn that
    // is merely slow rather than wedged. While a watcher (Monitor) is running, the
    // process is *expected* to sit quiet — don't reap it; re-arm instead, bounded
    // by an absolute hold cap so a stuck watcher can't pin a process open forever.
    const INACTIVITY_MS = 10 * 60 * 1000;
    const MAX_WATCHER_HOLD_MS = 30 * 60 * 1000;
    const runStartedAt = Date.now();
    const onInactivity = () => {
      if (this.hasActiveWatchers(channelId) && Date.now() - runStartedAt < MAX_WATCHER_HOLD_MS) {
        const count = this.channelWatchers.get(channelId)?.size ?? 0;
        console.log(`Inactivity window elapsed but ${count} watcher(s) active in channel ${channelId}; not reaping`);
        timeout = setTimeout(onInactivity, INACTIVITY_MS);
        return;
      }
      this.handleProcessTimeout(channelId, claude);
    };
    let timeout = setTimeout(onInactivity, INACTIVITY_MS);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(onInactivity, INACTIVITY_MS);
    };

    claude.stdout.on("data", (data) => {
      resetTimeout();
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
              } else if (p.type === "result" && p.subtype === "success" && p.is_error !== true) {
                // The turn finished cleanly. The CLI does its own transient retries
                // (e.g. "Unable to connect… Retrying" on stderr) and may recover on
                // its own — a success result means any earlier blip is moot, so don't
                // resume.
                this.apiErrorThisRun.delete(channelId);
              }
            }

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "user" && parsed.message.content) {
              this.handleToolResultMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "rate_limit_event") {
              this.handleRateLimitEvent(channelId, parsed).catch(console.error);
            } else if (parsed.type === "result") {
              this.handleResultMessage(channelId, parsed).then(() => {
                if (this.hasActiveWatchers(channelId)) {
                  // A turn's `result` is not the end of the process when a Monitor
                  // watcher is still running — keep it alive to deliver the watcher's
                  // notification. It exits on its own once watchers finish.
                  this.resultSeen.add(channelId);
                  const count = this.channelWatchers.get(channelId)?.size ?? 0;
                  console.log(`Result received; ${count} watcher(s) active in channel ${channelId} — keeping process alive`);
                  resetTimeout();
                } else if (this.streamingChannels.has(channelId)) {
                  // Streaming input: close stdin (EOF) so the process drains any
                  // injected messages still queued and exits gracefully. Completion
                  // was deferred and fires on close. Keep the reaper armed as a backstop.
                  console.log(`Result received in streaming channel ${channelId}; closing stdin for graceful exit`);
                  try { claude.stdin.end(); } catch {}
                  resetTimeout();
                } else {
                  clearTimeout(timeout);
                  claude.kill("SIGTERM");
                  this.channelProcesses.delete(channelId);
                }
              }).catch(console.error);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.handleInitMessage(channelId, parsed).catch(console.error);
              } else if (
                parsed.subtype === "task_started" ||
                parsed.subtype === "task_notification" ||
                parsed.subtype === "task_updated"
              ) {
                this.handleTaskMessage(channelId, parsed).then(() => {
                  // If the turn already finished and all watchers have now drained,
                  // re-arm the (now watcher-less) reaper as a backstop and let the
                  // process exit. A streaming-input process won't exit until stdin
                  // closes, so send EOF here.
                  if (this.resultSeen.has(channelId) && !this.hasActiveWatchers(channelId)) {
                    console.log(`All watchers drained after result in channel ${channelId}; closing input and awaiting exit`);
                    if (this.streamingChannels.has(channelId)) {
                      try { claude.stdin.end(); } catch {}
                    }
                    resetTimeout();
                  }
                }).catch(console.error);
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
      clearTimeout(timeout);
      this.clearQuestionWatchdog(channelId);
      this.stopTypingIndicator(channelId);
      // Ensure cleanup on process close
      this.channelProcesses.delete(channelId);

      // Question-hang recovery: this run was killed because it went silent after
      // an AskUserQuestion was answered. Resume the session replaying the answers
      // instead of finalizing the turn. Same shape as the API-error path below —
      // the queue stays held so no new turn starts underneath.
      const questionAnswers = this.questionRecovery.get(channelId);
      if (questionAnswers !== undefined) {
        this.questionRecovery.delete(channelId);
        this.apiErrorThisRun.delete(channelId);
        this.channelWatchers.delete(channelId);
        this.resultSeen.delete(channelId);
        this.pendingCompletion.delete(channelId);
        this.notifiedTasks.delete(channelId);
        this.initPosted.delete(channelId);
        this.streamingChannels.delete(channelId);
        this.retryTurn(channelId, this.buildQuestionReplayPrompt(questionAnswers));
        return;
      }

      // API-error auto-resume: if this run hit an API error, don't finalize the
      // turn. Reset the per-run streaming/watcher state (the resumed run rebuilds
      // it) and schedule the next resume with escalating backoff. We intentionally
      // do NOT call notifyComplete, so the queue stays held and no new turn starts.
      if (this.apiErrorThisRun.has(channelId)) {
        this.apiErrorThisRun.delete(channelId);
        this.channelWatchers.delete(channelId);
        this.resultSeen.delete(channelId);
        this.pendingCompletion.delete(channelId);
        this.notifiedTasks.delete(channelId);
        this.initPosted.delete(channelId);
        this.streamingChannels.delete(channelId);
        this.scheduleApiRetry(channelId);
        return;
      }
      // Clean end for this run — reset the backoff so the next independent API
      // error starts again at 10s.
      this.apiRetryState.delete(channelId);

      // Did the turn already succeed? (completion fired at result, or was deferred
      // because watchers were holding the process open). Capture before notifying.
      const deferred = this.pendingCompletion.get(channelId);
      const turnSucceeded =
        this.resultSeen.has(channelId) ||
        deferred !== undefined ||
        this.completionNotified.has(channelId);

      // Advance the queue. For watcher-holding runs this is where completion
      // actually fires (deferred from `result`); otherwise it's the crash
      // fallback. notifyComplete is guarded, so an earlier success wins.
      this.notifyComplete(channelId, deferred ?? "failed");

      // Clean up watcher/streaming state for this run
      this.channelWatchers.delete(channelId);
      this.resultSeen.delete(channelId);
      this.pendingCompletion.delete(channelId);
      this.notifiedTasks.delete(channelId);
      this.initPosted.delete(channelId);
      this.streamingChannels.delete(channelId);

      // Only surface an exit-code error if the turn didn't already complete
      // successfully — a non-zero exit during watcher teardown is not a failure.
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
      clearTimeout(timeout);
      this.stopTypingIndicator(channelId);

      // Clean up process tracking on error
      this.channelProcesses.delete(channelId);

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

    // The CLI can re-emit `init` mid-run (e.g. after watchers tear down). Only
    // post the "Session Started" embed once per run.
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
      .setDescription(`The **${limitLabel}** limit was hit.\n**Resets:** ${resetText}`)
      .setColor(0xE74C3C);

    try {
      await channel.send({ content: mention, embeds: [embed] });
    } catch (error) {
      console.error("Error sending rate limit message:", error);
    }
  }

  /** True while one or more Monitor/watcher tasks are running for this channel. */
  hasActiveWatchers(channelId: string): boolean {
    return (this.channelWatchers.get(channelId)?.size ?? 0) > 0;
  }

  private readonly TERMINAL_TASK_STATUSES = new Set([
    "stopped", "killed", "completed", "failed", "error", "done",
  ]);

  /**
   * Handle a background-task (Monitor) lifecycle event: maintain the per-channel
   * watcher set and surface notifications to Discord.
   */
  private async handleTaskMessage(channelId: string, parsed: any): Promise<void> {
    const taskId = parsed.task_id;
    if (!taskId) return;

    let watchers = this.channelWatchers.get(channelId);
    if (!watchers) {
      watchers = new Set<string>();
      this.channelWatchers.set(channelId, watchers);
    }

    if (parsed.subtype === "task_started") {
      watchers.add(taskId);
      console.log(`Watcher started (task ${taskId}); ${watchers.size} active in channel ${channelId}`);
      return;
    }

    // A user-facing notification — post it (deduped) to Discord.
    if (parsed.subtype === "task_notification") {
      await this.postWatcherNotification(channelId, parsed);
    }

    // Remove from the active set once the task reaches a terminal status.
    const status: string | undefined = parsed.status || parsed.patch?.status;
    if (status && this.TERMINAL_TASK_STATUSES.has(status) && watchers.has(taskId)) {
      watchers.delete(taskId);
      console.log(`Watcher finished (task ${taskId}, status ${status}); ${watchers.size} remaining in channel ${channelId}`);
    }
  }

  /**
   * Post a watcher's notification to Discord. Reads the task's output file (the
   * CLI hands us a path rather than inline content) and includes its tail.
   * Deduped per task — in normal operation a watcher fires a single notification.
   */
  private async postWatcherNotification(channelId: string, parsed: any): Promise<void> {
    const taskId = parsed.task_id;
    if (!taskId) return;

    let notified = this.notifiedTasks.get(channelId);
    if (!notified) {
      notified = new Set<string>();
      this.notifiedTasks.set(channelId, notified);
    }
    if (notified.has(taskId)) return;

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

    notified.add(taskId);

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

  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName, this.channelRunModel.get(channelId));

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

    // Notify completion early so the close handler doesn't race and mark it as
    // failed. But if a watcher is still running — or the process is in streaming
    // mode and we're about to close stdin for a graceful exit — defer until the
    // process actually closes. Advancing the queue now could spawn a second
    // process for this channel (two writers on the same session).
    if (this.hasActiveWatchers(channelId) || this.streamingChannels.has(channelId)) {
      this.pendingCompletion.set(channelId, success ? "success" : "partial");
      console.log(`Deferring completion for channel ${channelId} until process close (watchers/streaming active)`);
    } else {
      this.notifyComplete(channelId, success ? "success" : "partial");
    }

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

    // Close database connection
    this.db.close();
  }
}
