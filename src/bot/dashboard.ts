/**
 * The at-a-glance dashboard: one DM message, edited in place, listing every
 * project channel in the home category with its live state and cost.
 *
 * Why a DM message and not the channel title: renaming a channel or thread is
 * capped at 2 changes per 10 minutes (Discord throttles `name`/`topic` on
 * PATCH /channels/{id}), which a per-turn indicator blows through instantly and
 * then sits on a stale value. Editing one message is ~5 per 5 seconds, so the
 * dashboard can track state at the speed state actually changes. Channel names
 * are also load-bearing here — they resolve to BASE_FOLDER/<name> — so encoding
 * status in them would repoint channels at folders that don't exist.
 */

/** Live state of one channel or thread, most-urgent first. */
export type ScopeState = "processing" | "waiting" | "watching" | "active" | "inactive";

/** What a "waiting" scope is blocked on. Both mean: it needs *you*. */
export type WaitingKind = "question" | "approval";

export interface ScopeStats {
  id: string;
  name: string;
  state: ScopeState;
  waitingKind?: WaitingKind;
  /** Accumulated cost of the session running right now (0 if none). */
  currentSessionCost: number;
  /** Cost of every session this scope has ever had, including cleared ones. */
  totalSessionsCost: number;
  /** Prompts that ran to completion here, across all sessions. */
  promptCount: number;
}

export interface ChannelGroup {
  channel: ScopeStats;
  /** Threads given their own row. Archived threads are folded in, not listed. */
  threads: ScopeStats[];
  /** channel + every thread, listed or folded. */
  rollupCost: number;
  rollupPromptCount: number;
  /** Threads counted in the rollup but not listed (archived). */
  foldedThreadCount: number;
}

/**
 * Everything the dashboard needs to know about a scope, so the model can be
 * built and tested without Discord or a database.
 */
export interface DashboardDataSource {
  getChannelCostInfo(channelId: string): { sessionId: string; totalCostUsd: number } | undefined;
  getPausedSessions(channelId: string): { totalCostUsd: number; isResumable: boolean }[];
  getPromptCount(channelId: string): number;
  /**
   * Every channel or thread that has recorded history — a live session, a paused
   * one, or a finished prompt. The home category can't be the only way in: a
   * project channel that sits outside any category, or a thread that has since
   * been archived, still has spend that belongs on the dashboard.
   */
  getKnownScopeIds(): string[];
  hasActiveProcess(channelId: string): boolean;
  /** True when a background watcher is live, with or without a turn in flight. */
  hasActiveWatchers(channelId: string): boolean;
  /** Undefined when the scope isn't blocked on the user. */
  getWaitingKind(channelId: string): WaitingKind | undefined;
}

export interface ScopeRef {
  id: string;
  name: string;
}

/** A thread as discovered from Discord, before it's grouped under its channel. */
export interface ThreadRef extends ScopeRef {
  parentId: string;
  /** Archived threads are folded into the rollup instead of getting a row. */
  archived: boolean;
}

/**
 * Resolve one channel/thread's state and totals.
 *
 * State precedence is waiting > processing > watching > active > inactive: a
 * scope can be both running and blocked on a question (the process is alive while
 * the CLI waits on the answer), and "waiting" is the one you can act on, so it
 * wins over a bare "processing".
 *
 * "Watching" is the state that only exists because a channel's process outlives
 * its turns: nothing is running, but a background watcher is still armed and will
 * wake Claude when it fires. It's below "processing" (a turn in flight subsumes
 * it) and above "active" (a session with a live watcher is doing more than
 * merely existing).
 */
export function buildScopeStats(scope: ScopeRef, source: DashboardDataSource): ScopeStats {
  const current = source.getChannelCostInfo(scope.id);
  const currentSessionCost = current?.totalCostUsd ?? 0;

  // Paused rows carry the cost of sessions that are no longer current, including
  // is_resumable=0 archives written by /clear — that's the whole reason /clear
  // archives instead of deleting, so cleared spend still shows up in totals.
  const pausedCost = source
    .getPausedSessions(scope.id)
    .reduce((sum, p) => sum + (p.totalCostUsd ?? 0), 0);

  const waitingKind = source.getWaitingKind(scope.id);
  let state: ScopeState;
  if (waitingKind) state = "waiting";
  else if (source.hasActiveProcess(scope.id)) state = "processing";
  else if (source.hasActiveWatchers(scope.id)) state = "watching";
  else if (current) state = "active";
  else state = "inactive";

  return {
    id: scope.id,
    name: scope.name,
    state,
    waitingKind,
    currentSessionCost,
    totalSessionsCost: currentSessionCost + pausedCost,
    promptCount: source.getPromptCount(scope.id),
  };
}

/**
 * Group a channel with its threads and roll the totals up.
 *
 * `listedThreads` get their own row; `foldedThreads` (archived) contribute to
 * the rollup only — otherwise the message grows without bound as threads
 * accumulate over the life of a project.
 */
export function buildChannelGroup(
  channel: ScopeRef,
  listedThreads: ScopeRef[],
  foldedThreads: ScopeRef[],
  source: DashboardDataSource,
): ChannelGroup {
  const channelStats = buildScopeStats(channel, source);
  const threads = listedThreads.map(t => buildScopeStats(t, source));
  const folded = foldedThreads.map(t => buildScopeStats(t, source));

  const all = [channelStats, ...threads, ...folded];
  return {
    channel: channelStats,
    threads,
    rollupCost: all.reduce((sum, s) => sum + s.totalSessionsCost, 0),
    rollupPromptCount: all.reduce((sum, s) => sum + s.promptCount, 0),
    foldedThreadCount: folded.length,
  };
}

/**
 * Fold a flat set of discovered scopes into one group per channel.
 *
 * Threads arrive flat because they're discovered two different ways — the
 * guild's active-thread list, and resolving ids that only the database knew
 * about — and both hand back a parent id rather than a place in a tree. A
 * thread whose parent isn't in `channels` is dropped: its spend already belongs
 * to a project we aren't showing, and inventing a row for the orphan would
 * double-count it the moment the parent appears.
 */
export function buildGroups(
  channels: ScopeRef[],
  threads: ThreadRef[],
  source: DashboardDataSource,
): ChannelGroup[] {
  const byParent = new Map<string, ThreadRef[]>();
  for (const t of threads) {
    const siblings = byParent.get(t.parentId);
    if (siblings) siblings.push(t);
    else byParent.set(t.parentId, [t]);
  }

  return channels.map(ch => {
    const own = byParent.get(ch.id) ?? [];
    return buildChannelGroup(
      ch,
      own.filter(t => !t.archived),
      own.filter(t => t.archived),
      source,
    );
  });
}

const STATE_LABEL: Record<ScopeState, string> = {
  processing: "🟢 Processing",
  waiting: "🟡 Waiting",
  watching: "👀 Watching",
  active: "🔵 Active",
  inactive: "⚪ Inactive",
};

// 4 decimals to match /costreview exactly — the two views read the same rows,
// and rounding them differently makes identical numbers look like a discrepancy.
export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function describeState(s: ScopeStats): string {
  const label = STATE_LABEL[s.state];
  return s.state === "waiting" && s.waitingKind ? `${label} (${s.waitingKind})` : label;
}

function statsSuffix(s: ScopeStats): string {
  const parts: string[] = [];
  // Only worth showing when there's a live session distinct from the total.
  if (s.currentSessionCost > 0 && s.currentSessionCost !== s.totalSessionsCost) {
    parts.push(`${formatCost(s.currentSessionCost)} session`);
  }
  parts.push(`${formatCost(s.totalSessionsCost)} all`);
  parts.push(`${s.promptCount} prompt${s.promptCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export interface RenderOptions {
  /** Seconds-since-epoch for Discord's relative timestamp. */
  updatedAtSeconds: number;
  /** Embed description cap, minus headroom. Exposed for tests. */
  maxLength?: number;
}

/**
 * Render the dashboard body. Sorted so anything needing you floats to the top,
 * then the busy ones, then by spend — a glance at the first line should be
 * enough on a normal day.
 */
export function renderDashboard(groups: ChannelGroup[], opts: RenderOptions): string {
  const limit = opts.maxLength ?? 4096 - 96;

  if (groups.length === 0) {
    return "No project channels found — nothing has run yet. Run `/init` in your project category to list idle channels here too.";
  }

  const STATE_RANK: Record<ScopeState, number> = {
    waiting: 0,
    processing: 1,
    watching: 2,
    active: 3,
    inactive: 4,
  };

  // A channel sorts by the most urgent state anywhere inside it, so a thread
  // blocked on a question pulls its whole project to the top where you'll see it.
  const urgency = (g: ChannelGroup) =>
    Math.min(STATE_RANK[g.channel.state], ...g.threads.map(t => STATE_RANK[t.state]));

  const sorted = [...groups].sort((a, b) => {
    const byState = urgency(a) - urgency(b);
    if (byState !== 0) return byState;
    return b.rollupCost - a.rollupCost;
  });

  const blocks: string[] = [];
  for (const g of sorted) {
    const lines = [`${describeState(g.channel)} · <#${g.channel.id}> — ${statsSuffix(g.channel)}`];

    for (const t of g.threads) {
      lines.push(`　↳ ${describeState(t)} · <#${t.id}> — ${statsSuffix(t)}`);
    }

    // The rollup only says something new once a thread has contributed to it.
    if (g.threads.length > 0 || g.foldedThreadCount > 0) {
      const folded = g.foldedThreadCount > 0 ? ` (+${g.foldedThreadCount} archived)` : "";
      lines.push(
        `　└ **with threads${folded}: ${formatCost(g.rollupCost)} · ${g.rollupPromptCount} prompts**`,
      );
    }

    blocks.push(lines.join("\n"));
  }

  const grandTotal = sorted.reduce((sum, g) => sum + g.rollupCost, 0);
  const grandPrompts = sorted.reduce((sum, g) => sum + g.rollupPromptCount, 0);
  const footer =
    `\n\n**All projects: ${formatCost(grandTotal)} · ${grandPrompts} prompts**` +
    `\nUpdated <t:${opts.updatedAtSeconds}:R>`;

  // Drop whole channel blocks rather than cutting mid-line, so the message never
  // shows a half-rendered row — and always keep the totals, which is the part
  // you'd actually miss.
  let body = blocks.join("\n\n");
  if (body.length + footer.length > limit) {
    const kept: string[] = [];
    let used = 0;
    for (const block of blocks) {
      const cost = block.length + (kept.length ? 2 : 0);
      if (used + cost + footer.length > limit - 40) break;
      kept.push(block);
      used += cost;
    }
    const hidden = blocks.length - kept.length;
    body = kept.join("\n\n") + (hidden > 0 ? `\n\n_… ${hidden} more channel(s) not shown_` : "");
  }

  return body + footer;
}
