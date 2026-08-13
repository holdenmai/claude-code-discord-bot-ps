import { spawnSync } from "child_process";

/**
 * Kill a spawned process *and everything it spawned*.
 *
 * `child.kill()` signals one process. On Windows it isn't even a signal — Node
 * maps it to TerminateProcess — and Windows has no notion of killing a process
 * group by parent. Whatever the child spawned is simply reparented and lives on.
 *
 * The Claude CLI always has at least one such child: `node mcp-bridge.cjs`, the
 * stdio bridge that holds an open socket to the bot's permission server. Kill
 * `claude.exe` alone and the bridge is orphaned, still connected, still holding
 * the pipe handles it inherited. This barely mattered when a CLI process lived
 * for exactly one turn; now that a process is a session host that outlives its
 * turns, a shutdown can orphan one per channel at once — and the port they're
 * attached to reads as busy long after the thing that opened it is gone.
 *
 * POSIX gets the plain signal: our children aren't spawned `detached`, so they
 * share our process group, and a group kill would take the bot down with them.
 * There the CLI reaps its own children when it exits.
 */
export interface TreeKillDeps {
  platform: string;
  run: (command: string, args: string[]) => void;
}

const defaultDeps: TreeKillDeps = {
  platform: process.platform,
  run: (command, args) => {
    spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  },
};

export interface KillableProcess {
  pid?: number;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Best-effort, synchronous, and never throws: every caller is already on an
 * error path (an escalation, a timeout, a process `exit` handler) where the
 * only thing worse than failing to kill something is failing loudly.
 */
export function killProcessTree(
  proc: KillableProcess | undefined | null,
  signal: NodeJS.Signals = "SIGKILL",
  deps: TreeKillDeps = defaultDeps,
): void {
  if (!proc) return;

  // Already reaped — the pid may well belong to something else by now.
  if (proc.exitCode !== null && proc.exitCode !== undefined) return;
  if (proc.signalCode) return;

  if (deps.platform === "win32" && proc.pid) {
    try {
      // /T takes the descendants with it, /F because we only get here after the
      // polite route (stdin EOF, then SIGTERM) has already been declined.
      deps.run("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
      return;
    } catch {
      // taskkill missing or refused — fall through to the single-process kill.
    }
  }

  try {
    proc.kill(signal);
  } catch {
    // Gone between the check and here. Nothing to do.
  }
}
