import { describe, it, expect } from "vitest";
import {
  buildScopeStats,
  buildChannelGroup,
  buildGroups,
  renderDashboard,
  formatCost,
  type DashboardDataSource,
} from "../../src/bot/dashboard.js";

interface FakeScope {
  current?: { sessionId: string; totalCostUsd: number };
  paused?: { totalCostUsd: number; isResumable: boolean }[];
  prompts?: number;
  processing?: boolean;
  watching?: boolean;
  waiting?: "question" | "approval";
}

function makeSource(scopes: Record<string, FakeScope>): DashboardDataSource {
  return {
    getChannelCostInfo: (id) => scopes[id]?.current,
    getPausedSessions: (id) => scopes[id]?.paused ?? [],
    getPromptCount: (id) => scopes[id]?.prompts ?? 0,
    hasActiveProcess: (id) => scopes[id]?.processing ?? false,
    hasActiveWatchers: (id) => scopes[id]?.watching ?? false,
    getWaitingKind: (id) => scopes[id]?.waiting,
    getKnownScopeIds: () => Object.keys(scopes),
  };
}

const RENDER_OPTS = { updatedAtSeconds: 1_700_000_000 };

describe("buildScopeStats", () => {
  it("reports inactive when the channel has no session at all", () => {
    const source = makeSource({ a: {} });
    expect(buildScopeStats({ id: "a", name: "proj" }, source).state).toBe("inactive");
  });

  it("reports active when a session exists but nothing is running", () => {
    const source = makeSource({ a: { current: { sessionId: "s1", totalCostUsd: 1 } } });
    expect(buildScopeStats({ id: "a", name: "proj" }, source).state).toBe("active");
  });

  it("reports processing when a run is in flight", () => {
    const source = makeSource({
      a: { current: { sessionId: "s1", totalCostUsd: 1 }, processing: true },
    });
    expect(buildScopeStats({ id: "a", name: "proj" }, source).state).toBe("processing");
  });

  it("reports watching when the turn is over but a background watcher is still armed", () => {
    const source = makeSource({
      a: { current: { sessionId: "s1", totalCostUsd: 1 }, watching: true },
    });
    expect(buildScopeStats({ id: "a", name: "proj" }, source).state).toBe("watching");
  });

  it("prefers processing over watching — a turn in flight subsumes the watcher", () => {
    const source = makeSource({
      a: { current: { sessionId: "s1", totalCostUsd: 1 }, processing: true, watching: true },
    });
    expect(buildScopeStats({ id: "a", name: "proj" }, source).state).toBe("processing");
  });

  it("prefers waiting over processing — the process is alive while it blocks on you", () => {
    const source = makeSource({
      a: { current: { sessionId: "s1", totalCostUsd: 1 }, processing: true, waiting: "question" },
    });
    const stats = buildScopeStats({ id: "a", name: "proj" }, source);
    expect(stats.state).toBe("waiting");
    expect(stats.waitingKind).toBe("question");
  });

  it("counts cleared (non-resumable) sessions toward the total but not the current cost", () => {
    const source = makeSource({
      a: {
        current: { sessionId: "s2", totalCostUsd: 0.5 },
        paused: [
          { totalCostUsd: 1.25, isResumable: true },
          { totalCostUsd: 2, isResumable: false }, // archived by /clear
        ],
      },
    });
    const stats = buildScopeStats({ id: "a", name: "proj" }, source);
    expect(stats.currentSessionCost).toBe(0.5);
    expect(stats.totalSessionsCost).toBe(3.75);
  });

  it("still reports totals for a cleared channel with no current session", () => {
    const source = makeSource({
      a: { paused: [{ totalCostUsd: 4, isResumable: false }], prompts: 9 },
    });
    const stats = buildScopeStats({ id: "a", name: "proj" }, source);
    expect(stats.state).toBe("inactive");
    expect(stats.currentSessionCost).toBe(0);
    expect(stats.totalSessionsCost).toBe(4);
    expect(stats.promptCount).toBe(9);
  });
});

describe("buildChannelGroup", () => {
  it("rolls archived threads into the totals without listing them", () => {
    const source = makeSource({
      ch: { current: { sessionId: "s1", totalCostUsd: 1 }, prompts: 10 },
      live: { current: { sessionId: "s2", totalCostUsd: 2 }, prompts: 5 },
      old: { paused: [{ totalCostUsd: 4, isResumable: false }], prompts: 7 },
    });

    const group = buildChannelGroup(
      { id: "ch", name: "proj" },
      [{ id: "live", name: "live-thread" }],
      [{ id: "old", name: "archived-thread" }],
      source,
    );

    expect(group.threads.map(t => t.id)).toEqual(["live"]);
    expect(group.foldedThreadCount).toBe(1);
    expect(group.rollupCost).toBe(7);
    expect(group.rollupPromptCount).toBe(22);
  });

  it("has a rollup equal to the channel alone when it has no threads", () => {
    const source = makeSource({ ch: { current: { sessionId: "s1", totalCostUsd: 3 }, prompts: 2 } });
    const group = buildChannelGroup({ id: "ch", name: "proj" }, [], [], source);
    expect(group.rollupCost).toBe(3);
    expect(group.rollupPromptCount).toBe(2);
    expect(group.foldedThreadCount).toBe(0);
  });
});

describe("buildGroups", () => {
  it("hangs each thread off its parent channel, archived ones folded", () => {
    const source = makeSource({
      ch: { current: { sessionId: "s1", totalCostUsd: 1 }, prompts: 1 },
      other: {},
      live: { current: { sessionId: "s2", totalCostUsd: 2 }, prompts: 2 },
      old: { paused: [{ totalCostUsd: 4, isResumable: false }], prompts: 3 },
    });

    const groups = buildGroups(
      [{ id: "ch", name: "proj" }, { id: "other", name: "other" }],
      [
        { id: "live", name: "live", parentId: "ch", archived: false },
        { id: "old", name: "old", parentId: "ch", archived: true },
      ],
      source,
    );

    const proj = groups.find(g => g.channel.id === "ch")!;
    expect(proj.threads.map(t => t.id)).toEqual(["live"]);
    expect(proj.foldedThreadCount).toBe(1);
    expect(proj.rollupCost).toBe(7);
    expect(proj.rollupPromptCount).toBe(6);
    expect(groups.find(g => g.channel.id === "other")!.threads).toEqual([]);
  });

  it("drops a thread whose parent channel isn't being shown", () => {
    const source = makeSource({
      ch: { current: { sessionId: "s1", totalCostUsd: 1 } },
      orphan: { current: { sessionId: "s2", totalCostUsd: 99 } },
    });

    const groups = buildGroups(
      [{ id: "ch", name: "proj" }],
      [{ id: "orphan", name: "orphan", parentId: "gone", archived: false }],
      source,
    );

    expect(groups).toHaveLength(1);
    // The orphan's spend doesn't leak into an unrelated project's rollup.
    expect(groups[0]!.rollupCost).toBe(1);
  });
});

describe("renderDashboard", () => {
  it("points at /init when there is no home category to enumerate", () => {
    expect(renderDashboard([], RENDER_OPTS)).toContain("/init");
  });

  it("floats a waiting channel above a processing one", () => {
    const source = makeSource({
      busy: { current: { sessionId: "s1", totalCostUsd: 9 }, processing: true },
      blocked: { current: { sessionId: "s2", totalCostUsd: 0.01 }, waiting: "approval" },
    });
    const out = renderDashboard(
      [
        buildChannelGroup({ id: "busy", name: "busy" }, [], [], source),
        buildChannelGroup({ id: "blocked", name: "blocked" }, [], [], source),
      ],
      RENDER_OPTS,
    );
    expect(out.indexOf("<#blocked>")).toBeLessThan(out.indexOf("<#busy>"));
    expect(out).toContain("Waiting (approval)");
  });

  it("pulls a channel up when only one of its threads needs you", () => {
    const source = makeSource({
      quiet: { current: { sessionId: "s1", totalCostUsd: 50 } },
      other: { current: { sessionId: "s2", totalCostUsd: 80 } },
      t1: { current: { sessionId: "s3", totalCostUsd: 0.1 }, waiting: "question" },
    });
    const out = renderDashboard(
      [
        buildChannelGroup({ id: "other", name: "other" }, [], [], source),
        buildChannelGroup({ id: "quiet", name: "quiet" }, [{ id: "t1", name: "t1" }], [], source),
      ],
      RENDER_OPTS,
    );
    // "quiet" has the lower spend but holds the blocked thread, so it sorts first.
    expect(out.indexOf("<#quiet>")).toBeLessThan(out.indexOf("<#other>"));
  });

  it("shows the archived count in the rollup line", () => {
    const source = makeSource({
      ch: { current: { sessionId: "s1", totalCostUsd: 1 } },
      old: { paused: [{ totalCostUsd: 2, isResumable: false }] },
    });
    const out = renderDashboard(
      [buildChannelGroup({ id: "ch", name: "proj" }, [], [{ id: "old", name: "old" }], source)],
      RENDER_OPTS,
    );
    expect(out).toContain("+1 archived");
    expect(out).toContain(formatCost(3));
  });

  it("omits the rollup line for a channel with no threads", () => {
    const source = makeSource({ ch: { current: { sessionId: "s1", totalCostUsd: 1 } } });
    const out = renderDashboard(
      [buildChannelGroup({ id: "ch", name: "proj" }, [], [], source)],
      RENDER_OPTS,
    );
    expect(out).not.toContain("with threads");
  });

  it("drops whole channels when over length and always keeps the totals", () => {
    const scopes: Record<string, FakeScope> = {};
    const groups = [];
    for (let i = 0; i < 40; i++) {
      scopes[`ch${i}`] = { current: { sessionId: `s${i}`, totalCostUsd: 1 }, prompts: 3 };
    }
    const source = makeSource(scopes);
    for (let i = 0; i < 40; i++) {
      groups.push(buildChannelGroup({ id: `ch${i}`, name: `channel-${i}` }, [], [], source));
    }

    const out = renderDashboard(groups, { ...RENDER_OPTS, maxLength: 600 });

    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toContain("more channel(s) not shown");
    // The grand total covers everything, including the channels that got cut.
    expect(out).toContain(`${formatCost(40)} · 120 prompts`);
    // No row is left half-rendered.
    for (const line of out.split("\n")) {
      if (line.includes("<#")) expect(line).toMatch(/prompts?$/);
    }
  });

  it("hides the session figure when it is the whole of the total", () => {
    const source = makeSource({ ch: { current: { sessionId: "s1", totalCostUsd: 2 } } });
    const out = renderDashboard(
      [buildChannelGroup({ id: "ch", name: "proj" }, [], [], source)],
      RENDER_OPTS,
    );
    expect(out).not.toContain("session");
    expect(out).toContain(`${formatCost(2)} all`);
  });

  it("shows both figures once a channel has spend beyond its current session", () => {
    const source = makeSource({
      ch: {
        current: { sessionId: "s1", totalCostUsd: 2 },
        paused: [{ totalCostUsd: 3, isResumable: true }],
      },
    });
    const out = renderDashboard(
      [buildChannelGroup({ id: "ch", name: "proj" }, [], [], source)],
      RENDER_OPTS,
    );
    expect(out).toContain(`${formatCost(2)} session`);
    expect(out).toContain(`${formatCost(5)} all`);
  });
});
