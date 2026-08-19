import { describe, it, expect } from "vitest";
import { killProcessTree, type TreeKillDeps } from "../../src/utils/process-tree.js";

function fakeProc(overrides: Partial<{ pid: number; exitCode: number | null; signalCode: any }> = {}) {
  const signals: (string | undefined)[] = [];
  return {
    proc: {
      pid: 1234,
      exitCode: null as number | null,
      signalCode: null,
      kill(signal?: any) {
        signals.push(signal);
        return true;
      },
      ...overrides,
    },
    signals,
  };
}

function recorder(platform: string): { deps: TreeKillDeps; calls: string[][] } {
  const calls: string[][] = [];
  return {
    deps: { platform, run: (command, args) => calls.push([command, ...args]) },
    calls,
  };
}

describe("killProcessTree", () => {
  it("takes the whole tree down on Windows, not just the child", () => {
    const { proc, signals } = fakeProc();
    const { deps, calls } = recorder("win32");

    killProcessTree(proc, "SIGTERM", deps);

    expect(calls).toEqual([["taskkill", "/PID", "1234", "/T", "/F"]]);
    // The bare signal would leave the CLI's own children behind.
    expect(signals).toEqual([]);
  });

  it("signals the process directly elsewhere — our children share our group", () => {
    const { proc, signals } = fakeProc();
    const { deps, calls } = recorder("linux");

    killProcessTree(proc, "SIGTERM", deps);

    expect(calls).toEqual([]);
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("falls back to the signal when taskkill can't be run", () => {
    const { proc, signals } = fakeProc();
    const deps: TreeKillDeps = {
      platform: "win32",
      run: () => {
        throw new Error("taskkill missing");
      },
    };

    killProcessTree(proc, "SIGKILL", deps);

    expect(signals).toEqual(["SIGKILL"]);
  });

  it("leaves an already-exited process alone — the pid may be someone else's now", () => {
    const { proc, signals } = fakeProc({ exitCode: 0 });
    const { deps, calls } = recorder("win32");

    killProcessTree(proc, "SIGTERM", deps);

    expect(calls).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("leaves a process that already died on a signal alone", () => {
    const { proc, signals } = fakeProc({ signalCode: "SIGTERM" });
    const { deps, calls } = recorder("win32");

    killProcessTree(proc, "SIGKILL", deps);

    expect(calls).toEqual([]);
    expect(signals).toEqual([]);
  });

  it("does nothing for a channel that has no process", () => {
    const { deps, calls } = recorder("win32");
    expect(() => killProcessTree(undefined, "SIGTERM", deps)).not.toThrow();
    expect(calls).toEqual([]);
  });

  it("never throws when the kill itself fails", () => {
    const proc = {
      pid: 7,
      exitCode: null,
      signalCode: null,
      kill() {
        throw new Error("ESRCH");
      },
    };
    const deps: TreeKillDeps = { platform: "linux", run: () => {} };
    expect(() => killProcessTree(proc, "SIGKILL", deps)).not.toThrow();
  });
});
