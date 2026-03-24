import { Database } from "bun:sqlite";
import * as path from "path";

export interface ChannelSession {
  channelId: string;
  sessionId: string;
  channelName: string;
  lastUsed: number;
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

    // Track actively running processes — rows left after crash = interrupted runs
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_runs (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        started_at INTEGER NOT NULL
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
    return stmt.all() as ChannelSession[];
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

  close(): void {
    this.db.close();
  }
}