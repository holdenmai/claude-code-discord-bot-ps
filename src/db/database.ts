import { Database } from "bun:sqlite";
import * as path from "path";

export interface ChannelSession {
  channelId: string;
  sessionId: string;
  channelName: string;
  lastUsed: number;
  lastSummary?: string;
  lastCostUsd?: number;
  lastNumTurns?: number;
}

export interface PausedSession {
  channelId: string;
  name: string;
  sessionId: string;
  pausedAt: number;
}

export interface Todo {
  id: number;
  channelId: string;
  parentChannelId?: string;
  text: string;
  completed: boolean;
  createdAt: number;
}

export class DatabaseManager {
  private db: Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(process.cwd(), "sessions.db");
    this.db = new Database(finalPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    // Create sessions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_sessions (
        channel_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        last_used INTEGER NOT NULL
      )
    `);

    // Add summary columns to channel_sessions (idempotent migration)
    try { this.db.exec("ALTER TABLE channel_sessions ADD COLUMN last_summary TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE channel_sessions ADD COLUMN last_cost_usd REAL"); } catch {}
    try { this.db.exec("ALTER TABLE channel_sessions ADD COLUMN last_num_turns INTEGER"); } catch {}
    try { this.db.exec("ALTER TABLE channel_sessions ADD COLUMN total_cost_usd REAL DEFAULT 0"); } catch {}

    // Track actively running processes — rows left after crash = interrupted runs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_runs (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        started_at INTEGER NOT NULL
      )
    `);

    // Prompt/result history for /status context
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        result_summary TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_prompt_history_channel
      ON prompt_history(channel_id, created_at DESC)
    `);

    // Paused (named) sessions per channel
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paused_sessions (
        channel_id TEXT NOT NULL,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        paused_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, name)
      )
    `);

    // Per-channel todos
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        parent_channel_id TEXT,
        text TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `);
  }

  getSession(channelId: string): string | undefined {
    const stmt = this.db.query("SELECT session_id FROM channel_sessions WHERE channel_id = ?");
    const result = stmt.get(channelId) as { session_id: string } | null;
    return result?.session_id;
  }

  setSession(channelId: string, sessionId: string, channelName: string): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO channel_sessions (channel_id, session_id, channel_name, last_used)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(channelId, sessionId, channelName, Date.now());
  }

  clearSession(channelId: string): void {
    const stmt = this.db.query("DELETE FROM channel_sessions WHERE channel_id = ?");
    stmt.run(channelId);
  }

  getAllSessions(): ChannelSession[] {
    const stmt = this.db.query("SELECT * FROM channel_sessions ORDER BY last_used DESC");
    return (stmt.all() as any[]).map(r => ({
      channelId: r.channel_id,
      sessionId: r.session_id,
      channelName: r.channel_name,
      lastUsed: r.last_used,
      lastSummary: r.last_summary ?? undefined,
      lastCostUsd: r.last_cost_usd ?? undefined,
      lastNumTurns: r.last_num_turns ?? undefined,
    }));
  }

  updateSessionSummary(channelId: string, summary: string, costUsd: number, numTurns: number): void {
    const stmt = this.db.query(`
      UPDATE channel_sessions SET last_summary = ?, last_cost_usd = ?, last_num_turns = ?, last_used = ?
      WHERE channel_id = ?
    `);
    stmt.run(summary, costUsd, numTurns, Date.now(), channelId);
  }

  /**
   * Add a request's cost to the channel's running session total and return the
   * new total. Resets naturally when the session row is cleared (/clear, /pause).
   */
  addSessionCost(channelId: string, costUsd: number): number {
    this.db.query(`
      UPDATE channel_sessions SET total_cost_usd = COALESCE(total_cost_usd, 0) + ?
      WHERE channel_id = ?
    `).run(costUsd, channelId);
    const row = this.db.query(
      "SELECT total_cost_usd FROM channel_sessions WHERE channel_id = ?"
    ).get(channelId) as { total_cost_usd: number } | null;
    return row?.total_cost_usd ?? costUsd;
  }

  // --- Prompt history ---

  addPromptHistory(channelId: string, prompt: string, resultSummary: string | null): void {
    const stmt = this.db.query(`
      INSERT INTO prompt_history (channel_id, prompt, result_summary, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(channelId, prompt, resultSummary, Date.now());

    // Prune to keep only the last 10 per channel
    this.db.query(`
      DELETE FROM prompt_history WHERE channel_id = ? AND id NOT IN (
        SELECT id FROM prompt_history WHERE channel_id = ? ORDER BY created_at DESC LIMIT 10
      )
    `).run(channelId, channelId);
  }

  getPromptHistory(channelId: string, limit: number = 5): { prompt: string; resultSummary: string | null; createdAt: number }[] {
    const stmt = this.db.query(`
      SELECT prompt, result_summary, created_at FROM prompt_history
      WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    return (stmt.all(channelId, limit) as any[]).map(r => ({
      prompt: r.prompt,
      resultSummary: r.result_summary,
      createdAt: r.created_at,
    })).reverse(); // chronological order
  }

  // Clean up old sessions (older than 30 days)
  cleanupOldSessions(): void {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const stmt = this.db.query("DELETE FROM channel_sessions WHERE last_used < ?");
    const result = stmt.run(thirtyDaysAgo);
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} old sessions`);
    }
  }

  // --- Paused sessions ---

  pauseSession(channelId: string, name: string, sessionId: string): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO paused_sessions (channel_id, name, session_id, paused_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(channelId, name, sessionId, Date.now());
  }

  getPausedSessions(channelId: string): PausedSession[] {
    const stmt = this.db.query(
      "SELECT * FROM paused_sessions WHERE channel_id = ? ORDER BY paused_at DESC"
    );
    return (stmt.all(channelId) as any[]).map(r => ({
      channelId: r.channel_id,
      name: r.name,
      sessionId: r.session_id,
      pausedAt: r.paused_at,
    }));
  }

  getPausedSession(channelId: string, name: string): PausedSession | undefined {
    const stmt = this.db.query(
      "SELECT * FROM paused_sessions WHERE channel_id = ? AND name = ?"
    );
    const r = stmt.get(channelId, name) as any | null;
    if (!r) return undefined;
    return {
      channelId: r.channel_id,
      name: r.name,
      sessionId: r.session_id,
      pausedAt: r.paused_at,
    };
  }

  deletePausedSession(channelId: string, name: string): boolean {
    const stmt = this.db.query("DELETE FROM paused_sessions WHERE channel_id = ? AND name = ?");
    return stmt.run(channelId, name).changes > 0;
  }

  // Active run tracking — for crash recovery
  markRunStarted(channelId: string, channelName: string): void {
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO active_runs (channel_id, channel_name, started_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(channelId, channelName, Date.now());
  }

  markRunCompleted(channelId: string): void {
    const stmt = this.db.query("DELETE FROM active_runs WHERE channel_id = ?");
    stmt.run(channelId);
  }

  getInterruptedRuns(): { channelId: string; channelName: string; startedAt: number }[] {
    const stmt = this.db.query("SELECT channel_id, channel_name, started_at FROM active_runs");
    return (stmt.all() as any[]).map(r => ({
      channelId: r.channel_id,
      channelName: r.channel_name,
      startedAt: r.started_at,
    }));
  }

  clearAllActiveRuns(): void {
    this.db.exec("DELETE FROM active_runs");
  }

  // --- Todos ---

  addTodo(channelId: string, text: string, parentChannelId?: string): Todo {
    const stmt = this.db.query(`
      INSERT INTO todos (channel_id, parent_channel_id, text, completed, created_at)
      VALUES (?, ?, ?, 0, ?)
    `);
    const result = stmt.run(channelId, parentChannelId || null, text, Date.now());
    return {
      id: Number(result.lastInsertRowid),
      channelId,
      parentChannelId,
      text,
      completed: false,
      createdAt: Date.now(),
    };
  }

  getTodos(channelId: string): Todo[] {
    const stmt = this.db.query(
      "SELECT * FROM todos WHERE channel_id = ? ORDER BY created_at ASC"
    );
    return (stmt.all(channelId) as any[]).map(this.mapTodoRow);
  }

  getChannelAndChildTodos(channelId: string): Todo[] {
    const stmt = this.db.query(
      "SELECT * FROM todos WHERE channel_id = ? OR parent_channel_id = ? ORDER BY created_at ASC"
    );
    return (stmt.all(channelId, channelId) as any[]).map(this.mapTodoRow);
  }

  completeTodo(id: number): boolean {
    const stmt = this.db.query("UPDATE todos SET completed = 1 WHERE id = ?");
    return stmt.run(id).changes > 0;
  }

  uncompleteTodo(id: number): boolean {
    const stmt = this.db.query("UPDATE todos SET completed = 0 WHERE id = ?");
    return stmt.run(id).changes > 0;
  }

  clearCompletedTodos(channelId: string): number {
    const stmt = this.db.query("DELETE FROM todos WHERE channel_id = ? AND completed = 1");
    return stmt.run(channelId).changes;
  }

  private mapTodoRow(r: any): Todo {
    return {
      id: r.id,
      channelId: r.channel_id,
      parentChannelId: r.parent_channel_id ?? undefined,
      text: r.text,
      completed: r.completed === 1,
      createdAt: r.created_at,
    };
  }

  close(): void {
    this.db.close();
  }
}