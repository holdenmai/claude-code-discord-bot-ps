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
- `/shortcut` - Manage custom `!command` prompt shortcuts (global or per-repo)
- `/sync` - Merge main into all active worktrees for this project
- `/end` - End a worktree session: push branch to origin, remove worktree, lock thread
- `/adopt` - Adopt an external Claude CLI session into a new channel (with autocomplete)
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
- `QUESTION_WATCHDOG_SECONDS` - Silence allowed after AskUserQuestion answers are delivered before the turn is treated as wedged and recovered (default: 120)
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
