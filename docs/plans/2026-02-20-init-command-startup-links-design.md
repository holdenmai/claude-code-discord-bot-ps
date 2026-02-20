# /init Command & Startup Channel Links

## Problem

When the bot starts up, the DM just says "Bot is online". There's no quick way to jump back into a project channel — you have to manually navigate Discord.

## Solution

Add a `/init` command that saves the current channel's category as the "home" category. On startup, the DM includes clickable links to all channels in that category.

## Design

### `/init` command

- Run in any channel inside the desired project category
- Saves `{ guildId, categoryId }` to `settings.json` under `homeCategory`
- Replies with confirmation showing category name
- Running again overwrites the previous value

### Startup DM

After login, if `homeCategory` is set:
1. Fetch the guild and category
2. Get all text channels in that category, sorted by position
3. Format as `<#id>` links (Discord renders these as clickable, even in DMs)
4. Include in the startup message

Example:
```
🚀 Bot is online!
Logged in as ClaudeBot#1234

📂 Projects:
<#123> <#456> <#789> <#012>
<#345> <#678> <#901> <#234>

Ready to assist with Claude Code sessions.
```

## Files Changed

1. **`src/settings/settings-store.ts`** — Add `homeCategory` field (`{ guildId: string, categoryId: string }`) with getter/setter
2. **`src/bot/commands.ts`** — Add `/init` slash command definition and handler
3. **`src/bot/client.ts`** — Expand startup DM to fetch and list channels from saved category
