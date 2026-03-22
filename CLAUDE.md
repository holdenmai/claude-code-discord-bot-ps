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

### Commands
- Any message in a channel runs Claude Code with that prompt
- `/clear` - Reset the current session (starts fresh next time)
- `/kill` - Kill the running Claude Code process in this channel
- `/killall` - Kill all running Claude Code processes
- `/model` - Set the Claude model for this channel (sonnet/opus/haiku)
- `/add` - Create a channel for a project folder (with autocomplete)
- `/update` - Pull latest changes and restart the bot
- `/shortcut` - Manage custom `!command` prompt shortcuts (global or per-repo)
- `/sync` - Merge main into all active worktrees for this project
- `/init` - Set this channel's category as the home for startup links

## Environment Variables

Required environment variables:
- `DISCORD_TOKEN` - Bot token from Discord Developer Portal
- `ALLOWED_USER_ID` - Discord user ID who can use the bot
- `BASE_FOLDER` - Base path where Claude Code operates (e.g., `/Users/tim/repos`)
- `MCP_SERVER_PORT` - Port for MCP permission server (default: 3001)

Optional (multi-instance):
- `BOT_INSTANCE_ID` - Instance name (e.g., "linux", "windows"). Enables multi-instance routing
- `BOT_PRIORITY` - Integer priority (1 = highest, default: 1). Lower priority bots wait before processing

## Environment

- Bun automatically loads .env files (no need for dotenv)
- TypeScript is configured with strict mode and modern features
- No emit compilation (bundler handles this)

## Important Restrictions

- Never run the bot. You are not allowed to use the `bun run src/index.ts` command.
- You can run tests, but never run the main application.

## Testing Notes

- Use `bun run test:run` to run tests. Never use just `bun test`.
