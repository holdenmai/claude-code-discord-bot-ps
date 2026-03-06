import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

export interface WorktreeInfo {
  path: string;
  branch: string;
  exists: boolean;
}

/**
 * Get the worktree directory path for a thread within a repo.
 * Worktrees live at: BASE_FOLDER/channel-name/.worktrees/thread-name
 */
export function getWorktreePath(baseFolder: string, channelName: string, threadName: string): string {
  return path.join(baseFolder, channelName, ".worktrees", threadName);
}

/**
 * Check if a worktree already exists at the expected path.
 */
export function worktreeExists(baseFolder: string, channelName: string, threadName: string): boolean {
  const wtPath = getWorktreePath(baseFolder, channelName, threadName);
  return fs.existsSync(wtPath);
}

/**
 * Create a git worktree for a thread.
 * Creates a new branch from sourceBranch and sets up the worktree.
 */
export function createWorktree(
  baseFolder: string,
  channelName: string,
  threadName: string,
  branchName: string,
  sourceBranch: string = "main"
): WorktreeInfo {
  const repoDir = path.join(baseFolder, channelName);
  const wtPath = getWorktreePath(baseFolder, channelName, threadName);

  // Ensure .worktrees directory exists
  const worktreesDir = path.join(repoDir, ".worktrees");
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true });
  }

  // Check if branch already exists
  let branchExists = false;
  try {
    execSync(`git rev-parse --verify "${branchName}"`, { cwd: repoDir, stdio: "pipe" });
    branchExists = true;
  } catch {
    // Branch doesn't exist yet
  }

  if (branchExists) {
    // Use existing branch
    execSync(`git worktree add "${wtPath}" "${branchName}"`, { cwd: repoDir, stdio: "pipe" });
  } else {
    // Create new branch from source
    execSync(`git worktree add -b "${branchName}" "${wtPath}" "${sourceBranch}"`, { cwd: repoDir, stdio: "pipe" });
  }

  return { path: wtPath, branch: branchName, exists: true };
}

/**
 * List all git worktrees for a repo and check if one matches the thread name.
 */
export function getExistingWorktree(baseFolder: string, channelName: string, threadName: string): WorktreeInfo | null {
  const repoDir = path.join(baseFolder, channelName);
  const wtPath = getWorktreePath(baseFolder, channelName, threadName);

  if (!fs.existsSync(wtPath)) return null;

  // Get branch info from the worktree
  try {
    const branch = execSync("git branch --show-current", { cwd: wtPath, stdio: "pipe" }).toString().trim();
    return { path: wtPath, branch, exists: true };
  } catch {
    // Directory exists but isn't a valid worktree
    return null;
  }
}
