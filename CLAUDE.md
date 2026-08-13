# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime and Package Management

This project uses **Bun** as the JavaScript runtime instead of Node.js. Always use Bun commands:

- `bun install` - Install dependencies
- `bun run test:run` - Run tests

## Architecture

This is a TypeScript project with strict type checking enabled.

- `src/index.ts` - Entry point, wires up all subsystems
- `src/bot/client.ts` - Discord bot client, event handlers, message routing
- `src/bot/commands.ts` - Slash command definitions and handlers
- `src/claude/manager.ts` - Claude Code process lifecycle and streaming
- `src/claude/transcript.ts` - Reads CLI session `.jsonl` transcripts for `/online` (pure, no Discord)
- `src/mcp/server.ts` - MCP permission server for tool approvals
- `src/mcp/permission-manager.ts` - Interactive approval/denial via Discord
- `src/queue/message-queue.ts` - Per-channel message queue (one Claude process at a time)
- `src/settings/settings-store.ts` - Persistent settings (models, allowed tools, home category)
- `src/utils/shell.ts` - Claude CLI command builder and MCP config
- `src/utils/config.ts` - Environment variable validation

## Discord Bot Functionality

This bot runs Claude Code sessions on different projects based on Discord channel names:

- Each Discord channel maps to a folder: `BASE_FOLDER/channel-name`
- Sessions persist per channel with automatic resume using session IDs
- Only responds to messages from the configured `ALLOWED_USER_ID`
- Streams Claude Code output and updates Discord messages in real-time
- Shows the last 3 streamed responses in each message
- Use `/clear` slash command to reset a session

### One process per channel, not one per turn

A channel's Claude CLI process outlives the turn that spawned it. It is a *session
host*: prompts are written into its stdin as `stream-json` user messages, and it
stays up between turns.

This is not a caching trick — it's the only way background work survives. **The CLI
tears down every background task (`Monitor`, `run_in_background` shells) about 5
seconds after a turn's `result` if stdin has reached EOF.** Hold stdin open and the
same task runs to completion, fires its `task_notification`, and the CLI wakes
*itself* for a follow-up turn (`result.origin.kind === "task-notification"`). Before
this, the bot closed stdin at the result, so the "🔔 Watcher" message you saw was
the tombstone of a watcher the bot had just killed, never a watcher firing.

Consequences that shape the rest of the design:

- **The queue releases at `result`, not at process close.** Close used to be the
  release point precisely so a second process couldn't be spawned for a channel
  while the first lived; now "still alive" is the normal state, so the boundary
  moves to the turn.
- **`hasActiveProcess` means "a turn is in flight"**, not "a process exists". The
  two stopped being the same thing. `hasLiveProcess` is the other question.
- **A turn respawns instead of injecting when spawn args change** — model, plan
  mode, or working directory, all of which live in argv. The old process is retired
  first (stdin EOF, then SIGTERM, then SIGKILL) and the respawn *waits* for it: two
  CLIs writing one session transcript would interleave the conversation. The MCP
  config is not in that list — it's keyed on channel, and the message id baked into
  it isn't used for routing.
- **Raw `--` commands and image prompts can't be injected.** Their content is argv
  (`--image`, bare CLI args), not a stream-json message, so they keep the legacy
  `-p` path with stdin closed — and therefore can't host watchers at all.
- **Idle processes are retired** after `SESSION_IDLE_SECONDS`, or held up to
  `WATCHER_MAX_HOLD_SECONDS` while background tasks are live, so a watcher that
  never terminates can't pin a CLI and its MCP bridge open forever. Any output
  pushes the idle clock back, which is what keeps a watcher-driven turn — one we
  never "began" — from racing a shutdown timer armed before it started.
- **Live tasks come from `background_tasks_changed`**, a full snapshot, rather than
  counting `task_started` against terminal statuses. A status we didn't recognise
  used to strand a task in the set forever and hold the process open with it.
- **Watcher-driven turns are reported, not completed.** They carry no prompt, so
  they get no `prompt_costs` row (the prompt count means "prompts that finished"),
  never touch the last prompt's reactions or queue slot, and are dropped entirely
  when the CLI answers a notification with an empty zero-turn result. Their spend
  still lands on the session total.
- **The no-output reaper only runs mid-turn**, and is the only timer here that
  kills rather than retires. An idle process is supposed to be silent; silence is
  only evidence of a hang while a turn is in flight — and only then if nothing is
  legitimately being waited on. Two things are, and neither produces output: a
  live background task, and *you*, on an unanswered question or tool approval.
  Both re-arm the window instead of reaping, bounded by the same absolute hold
  cap. (A multi-question `AskUserQuestion` is the sharp case: each question gets
  its own answer budget, but nothing reaches the CLI until the last one is in, so
  the whole sitting is one unbroken silence.) The permission manager's pending map
  is the source for "waiting on you" — the same one the dashboard reads — passed
  in as a probe function rather than the object, since it already holds a
  reference back to the Claude manager.
- `/kill` will also retire an idle process that's holding watchers, and `/interrupt`
  and `/btw` refuse to write into an idle one — that would start a turn nothing is
  tracking.

### Stopping the bot

Once processes outlive their turns, stopping the bot stops being free. A shutdown
now finds several CLIs alive, and each of them has children of its own — at
minimum `node mcp-bridge.cjs`, which holds a socket to the permission server.

`child.kill()` reaches exactly one process. On Windows it isn't even a signal
(Node maps it to `TerminateProcess`) and there's no kill-by-parent, so the
grandchildren are simply reparented and live on, still holding the pipes and the
connection they inherited — a phantom with no visible owner, and a port that
reads as busy after the thing that bound it is gone. Every escalation path
therefore goes through `killProcessTree` (`taskkill /T /F` on Windows, the plain
signal elsewhere, where our children share our process group and the CLI reaps
its own).

Three ways out, in descending order of grace:

- **`/shutdown`** — the good one. Retires every process through the front door
  (stdin EOF, so each CLI drains and reaps its own children), then exits.
- **Ctrl+C / SIGTERM** — same graceful retire, under a 20s hard-exit deadline so
  a wedged teardown can't leave the process up holding the port. `SIGHUP` and
  Windows' `SIGBREAK` are wired to it too, so closing the terminal window isn't
  the one path that skips cleanup.
- **`process.exit`** (`/restart`, `/update`) — the `exit` handler can only do
  synchronous work, so it tree-kills rather than retires. `/restart` can't wait
  for a graceful retire anyway: `restart.vbs` relaunches after 2 seconds and the
  new process would collide with the old one on the MCP port.

### Model selection

The model is pinned **per session**, not per channel, so a conversation never
changes model mid-flight. When a session is created it records the model it ran
with (`channel_sessions.session_model`) and keeps it for its whole life, across
resumes and `/resume` after a pause. Resolution order for a run:

1. the session's pinned model
2. `LEGACY_SESSION_MODEL` for sessions created before pinning existed
3. the channel default (`/model`, else `DEFAULT_MODEL`) — new sessions only

`/model` sets the channel default *and* repins the current session, since it's an
explicit choice about the conversation on screen. Bare tier aliases (`opus`) are
resolved to concrete IDs before being pinned — an alias follows whatever the CLI
currently points that tier at, which is the drift pinning exists to prevent.

### Importing offline work

Work done in the Claude CLI (bot down, or just working at the terminal) leaves no
trace in Discord. `/online` replays a session's transcript
(`~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`) into the channel so the
channel stays the record of the conversation. It is strictly read-only: it never
launches the CLI, never answers a question the transcript recorded, and never
touches the live session.

Where the replay starts, in order:

1. the saved watermark (`transcript_imports.last_uuid`) if it's for the same session
2. the newest transcript text that already appears in the channel's last 100 messages
3. failing both, the last 10 turns

Anchoring is by *content*, not timestamp — the bot posts plenty of non-transcript
messages (startup links, error embeds), and one arriving after the last real reply
would push a timestamp anchor past the very work being imported.

The replay is condensed: prompts and Claude's prose get their own embeds, and each
turn's tool calls collapse to one summary line. Replaying every tool call after the
fact buries the channel — a three-day session is hundreds of embeds.

Options: `session` (id or paused-session name, default the channel's session),
`preview` (report without posting), `all` (whole transcript, ignoring the anchor).

### Naming a session on the way out

`/pause <name>` needs a name up front, which is exactly when you're least willing
to think of one. `/autopause` asks Claude instead, and doesn't make you wait:

1. the session is parked immediately under its own session id (same shape as
   `/resume`'s auto-pause), so the channel is free for new work at once
2. a one-shot CLI run resumes that session and asks it for a name
3. the paused row is renamed in place when the answer arrives

The naming run is deliberately outside the normal machinery — it never enters the
per-channel message queue and is never the channel's active process, or the "start
your next session immediately" part wouldn't hold. It uses `--fork-session`, so
the naming turn lands in a throwaway session id and the paused session's own
transcript is exactly what you left behind. It runs on the session's pinned model.

Everything about it is best-effort: a bad answer, a timeout, or a session that got
resumed before the name arrived all leave the session parked under its id, where
`/resume <id>` still finds it. Names are lowercased to `[a-z0-9-]`, capped at 32
characters (they're typed into `/resume` and packed into its autocomplete labels),
rejected if they're GUID-shaped (a paused name shadows a session id in `/resume`),
and suffixed `-2`, `-3`… on collision — `paused_sessions` is keyed on
`(channel_id, name)` and written with `INSERT OR REPLACE`, so reusing a name would
silently destroy the session already parked under it.

### The at-a-glance dashboard

One DM message, edited in place, lists every channel in the home category with
its live state and spend. It's posted right after the startup announcement, and
because the ready handler deletes every old bot DM on boot it's always a fresh
post — there's no message id to persist and no reattach path.

Per scope (channel or thread): state, the current session's cost, the cost of
every session it has ever had, and its completed-prompt count. Channel rows also
carry a rollup over the channel plus all its threads.

State is `Waiting > Processing > Active > Inactive`, in that precedence. Waiting
means blocked on *you* — an AskUserQuestion or a tool approval — and it outranks
Processing because both are true at once while the CLI sits on a question, and
Waiting is the one you can act on. It's read from `PermissionManager`'s in-memory
pending map, so it doesn't survive a restart; that's accurate rather than stale,
since the turn that raised the question didn't survive either.

Why a message and not the channel/thread title: Discord caps `name`/`topic` edits
at 2 per 10 minutes per channel, which a per-turn indicator exhausts immediately
and then sits wrong, while message edits allow ~5 per 5 seconds. Channel names
are also load-bearing — they resolve to `BASE_FOLDER/<name>` — so status in a
title would repoint a channel at a folder that doesn't exist.

Refreshes are event-driven (run start, run complete, approval raised or resolved,
any slash command) with a 2s coalescing window, plus a 30s backstop tick for state
that changes with no trigger, like an approval timing out.

Discovery comes from two directions, because neither one alone finds everything:

- **the home category**, for scopes with no history — a channel that has never
  run anything is exactly the "Inactive" case worth showing, and it has no
  database row to enumerate from
- **the database** (`channel_sessions` ∪ `paused_sessions` ∪ `prompt_costs`),
  for everything that has done work, wherever it lives. Project channels are not
  required to sit in a category, and a category-only sweep reported `$0` across
  the board on a server where none of them did. Threads found this way pull their
  parent channel in with them, so a thread's spend never lands under a project
  that isn't on screen.

Ids that no longer resolve (deleted channels keep their rows) are remembered as
missing for 30 minutes rather than re-fetched every tick. Live threads come from
one guild-wide active-thread call, not one call per channel. Archived threads are
folded into the channel rollup without a row of their own — listing them would
grow the message without bound — and only the ones with recorded history are
folded in at all, since an archived thread that never ran anything contributes
nothing but a `+1`.

Prompt counts come from `prompt_costs` (one row per prompt, never pruned), not
`prompt_history` (capped at the last 10 per channel). A row is only written when a
result arrives, so the count is prompts that *finished* — a `/kill`ed or crashed
turn never lands.

### Commands
- Any message in a channel runs Claude Code with that prompt
- `/clear` - Reset the current session (starts fresh next time)
- `/kill` - Kill the running Claude Code process in this channel
- `/stop` - Gracefully stop the current turn (stream-json `control_request`/`interrupt`, like pressing Esc); session is preserved
- `/killall` - Kill all running Claude Code processes
- `/model` - Set the model for this channel and repin the session in flight
- `/add` - Create a channel for a project folder (with autocomplete)
- `/update` - Pull latest changes and restart the bot
- `/restart` - Restart the bot without pulling changes
- `/shutdown` - Stop the bot cleanly, retiring every CLI process first
- `/shortcut` - Manage custom `!command` prompt shortcuts (global or per-repo)
- `/sync` - Merge main into all active worktrees for this project (conflicts
  listed first; the report spills into follow-up messages rather than being
  rejected whole once it passes Discord's 2000-character limit)
- `/end` - End a worktree session: push branch to origin, remove worktree, lock thread
- `/adopt` - Adopt an external Claude CLI session into a new channel (with autocomplete)
- `/online` - Import offline CLI work from a session's `.jsonl` transcript into the channel
- `/autopause` - Pause the current session and let Claude name it (name lands a bit later)
- `/status` - Show summary of recent activity across all project channels
- `/todo` - Per-channel todo notes (add/list/done/clear)
- `/init` - Set this channel's category as the home for startup links
- `!oncrash` shortcut - If configured, auto-runs on startup for any session interrupted by a crash

## Environment Variables

Required environment variables:
- `DISCORD_TOKEN` - Bot token from Discord Developer Portal
- `ALLOWED_USER_ID` - Discord user ID who can use the bot
- `BASE_FOLDER` - Base path where Claude Code operates (e.g., `/Users/tim/repos`)
- `MCP_SERVER_PORT` - Port for MCP permission server (default: 3001)

Optional (multi-instance):
- `BOT_INSTANCE_ID` - Instance name (e.g., "linux", "windows"). Enables multi-instance routing
- `BOT_PRIORITY` - Integer priority (1 = highest, default: 1). Lower priority bots wait before processing

Optional (models, timeouts, logging):
- `DEFAULT_MODEL` - Model new sessions start on (default: `claude-opus-5`)
- `LEGACY_SESSION_MODEL` - Model for sessions created before per-session pinning (default: `claude-opus-4-8`)
- `AUTOPAUSE_TIMEOUT_SECONDS` - How long `/autopause` waits for Claude to answer with a name before giving up and leaving the session under its id (default: 180)
- `QUESTION_WATCHDOG_SECONDS` - Silence allowed after AskUserQuestion answers are delivered before the turn is treated as wedged and recovered (default: 120)
- `SESSION_IDLE_SECONDS` - How long a channel's CLI process is kept alive with nothing to do, so the next prompt is an injection rather than a `--resume` (default: 600)
- `WATCHER_MAX_HOLD_SECONDS` - Ceiling on holding that process open for live background tasks, so a watcher that never finishes can't pin it forever (default: 21600)
- `TURN_INACTIVITY_SECONDS` - Silence allowed *within a turn* before the process is treated as hung and killed. Raise it if you run foreground builds near the CLI's own 600-second Bash cap (default: 600)
- `LOG_MAX_MB` - Rotate `log.txt` past this size, keeping one previous generation as `log.txt.1` (default: 256)

## Environment

- Bun automatically loads .env files (no need for dotenv)
- TypeScript is configured with strict mode and modern features
- No emit compilation (bundler handles this)

## Important Restrictions

- Never run the bot. You are not allowed to use the `bun run src/index.ts` command.
- You can run tests, but never run the main application.

## Testing Notes

- Use `bun run test:run` to run tests. Never use just `bun test`.
