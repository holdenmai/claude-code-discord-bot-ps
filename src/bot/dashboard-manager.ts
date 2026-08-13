import { EmbedBuilder } from "discord.js";
import {
  buildGroups,
  renderDashboard,
  type ChannelGroup,
  type DashboardDataSource,
  type ScopeRef,
  type ThreadRef,
} from "./dashboard.js";

// Coalescing window. Several triggers fire in a burst around a single turn
// (prompt in, approval up, approval answered, run complete); one edit a couple
// of seconds later covers all of them and keeps us far under Discord's ~5 edits
// per 5 seconds per channel.
const REFRESH_DEBOUNCE_MS = 2_000;

// Backstop for state that changes without a trigger — an approval timing out,
// a thread being archived. Slow on purpose: the event-driven path is what makes
// the dashboard feel live, this is only so it can't sit wrong indefinitely.
const REFRESH_INTERVAL_MS = 30_000;

// Channels and threads are deleted, but their rows in the database are not, so
// a handful of known ids resolve to a 404 forever. Remember the misses for a
// while rather than re-asking Discord about every one of them on every tick.
const MISSING_TTL_MS = 30 * 60_000;

/**
 * Owns the single dashboard message in the bot's DM with the allowed user:
 * where it lives, when it re-renders, and how the channel list is discovered.
 */
export class DashboardManager {
  private message: any = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private rendering = false;
  private dirty = false;
  private missingSince = new Map<string, number>();

  constructor(
    private client: any,
    private allowedUserId: string,
    private settings: { getHomeCategory(): { guildId: string; categoryId: string } | undefined } | undefined,
    private source: DashboardDataSource,
  ) {}

  /**
   * Post the dashboard fresh and start the backstop tick. Called from the ready
   * handler *after* the startup announcement — that handler deletes every old
   * bot DM on boot, so there is never a previous message worth reattaching to.
   */
  async start(): Promise<void> {
    try {
      const user = await this.client.users.fetch(this.allowedUserId);
      const embed = await this.buildEmbed();
      this.message = await user.send({ embeds: [embed] });
    } catch (error) {
      console.error("Dashboard: failed to post initial message:", error);
      return;
    }

    this.interval = setInterval(() => this.scheduleRefresh(), REFRESH_INTERVAL_MS);
    // Don't hold the process open for a status message.
    this.interval.unref?.();
  }

  /** Ask for a re-render. Safe to call as often as you like. */
  scheduleRefresh(): void {
    if (!this.message) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private async refresh(): Promise<void> {
    // A render is an await chain over the Discord API; a trigger landing during
    // one must not start a second. Mark it dirty and let the in-flight render
    // loop again, so the final state is always what gets displayed.
    if (this.rendering) {
      this.dirty = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.dirty = false;
        const embed = await this.buildEmbed();
        await this.message.edit({ embeds: [embed] });
      } while (this.dirty);
    } catch (error) {
      console.error("Dashboard: refresh failed:", error);
      // Most likely the message was deleted out from under us. Drop it and let
      // the next start() repost; a dead reference would fail forever otherwise.
      this.message = null;
    } finally {
      this.rendering = false;
    }
  }

  private async buildEmbed(): Promise<EmbedBuilder> {
    const groups = await this.collectGroups();
    return new EmbedBuilder()
      .setTitle("📊 Projects")
      .setDescription(renderDashboard(groups, { updatedAtSeconds: Math.floor(Date.now() / 1000) }))
      .setColor(0x5865f2);
  }

  /**
   * Work out which channels and threads to show, from two directions at once.
   *
   * The home category gives us the *idle* ones — a channel that has never run
   * anything has no row to enumerate from, and "Inactive" is a state worth
   * showing. The database gives us the ones that have actually done work,
   * wherever they live: project channels are not required to sit in a category
   * (this bot's own server has none of them in one), and threads get archived
   * out of every listing while keeping their spend.
   *
   * Category-only discovery is what made the dashboard read $0 — the home
   * category held one unused channel and every real project was outside it.
   */
  private async collectGroups(): Promise<ChannelGroup[]> {
    const channels = new Map<string, ScopeRef>();
    const threads = new Map<string, ThreadRef>();
    const home = this.settings?.getHomeCategory();
    let guild: any = null;

    if (home) {
      try {
        guild = await this.client.guilds.fetch(home.guildId);
        const all = await guild.channels.fetch();
        const inCategory = [...all.values()]
          .filter((ch: any) => ch && ch.parentId === home.categoryId && ch.isTextBased?.() && !ch.isThread?.())
          .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
        for (const ch of inCategory) channels.set(ch.id, { id: ch.id, name: ch.name });
      } catch (error) {
        console.error("Dashboard: failed to fetch home category channels:", error);
      }
    }

    // Everything with recorded history. Resolved in parallel — discord.js caches
    // channels, so this is one burst on the first render and free afterwards.
    const knownIds = this.source.getKnownScopeIds().filter(id => !channels.has(id));
    const resolved = await Promise.all(knownIds.map(id => this.resolveScope(id)));
    for (const scope of resolved) {
      if (!scope) continue;
      guild ??= scope.guild ?? null;

      if (!scope.isThread?.()) {
        channels.set(scope.id, { id: scope.id, name: scope.name });
        continue;
      }
      // A thread needs its channel present or it has nothing to hang off, and
      // the parent may well be outside the home category too.
      const parent = scope.parent ?? (scope.parentId ? await this.resolveScope(scope.parentId) : null);
      if (!parent) continue;
      if (!channels.has(parent.id)) channels.set(parent.id, { id: parent.id, name: parent.name });
      threads.set(scope.id, {
        id: scope.id,
        name: scope.name,
        parentId: parent.id,
        archived: !!scope.archived,
      });
    }

    // Live threads under channels we're already showing, including ones that
    // haven't finished a prompt yet. One guild-wide call, not one per channel.
    if (guild) {
      try {
        const active = await guild.channels.fetchActiveThreads();
        for (const t of active.threads.values()) {
          if (threads.has(t.id) || !channels.has(t.parentId)) continue;
          threads.set(t.id, { id: t.id, name: t.name, parentId: t.parentId, archived: false });
        }
      } catch (error) {
        console.error("Dashboard: failed to fetch active threads:", error);
      }
    }

    return buildGroups([...channels.values()], [...threads.values()], this.source);
  }

  /** Resolve a channel or thread id, remembering the ones that no longer exist. */
  private async resolveScope(id: string): Promise<any | null> {
    const missedAt = this.missingSince.get(id);
    if (missedAt !== undefined && Date.now() - missedAt < MISSING_TTL_MS) return null;
    try {
      const scope = await this.client.channels.fetch(id);
      if (scope) {
        this.missingSince.delete(id);
        return scope;
      }
    } catch {
      // Deleted, or no longer visible to the bot. Either way: not a row.
    }
    this.missingSince.set(id, Date.now());
    return null;
  }

  destroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }
}
