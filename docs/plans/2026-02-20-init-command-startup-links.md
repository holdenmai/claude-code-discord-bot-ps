# /init Command & Startup Channel Links — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/init` command to set the home category, and include clickable channel links in the startup DM.

**Architecture:** Extend `SettingsStore` with a `homeCategory` field. Add `/init` slash command that saves the current channel's category. On startup, the bot fetches channels from that category and includes them in the DM.

**Tech Stack:** TypeScript, discord.js, vitest

---

### Task 1: Add homeCategory to SettingsStore

**Files:**
- Modify: `src/settings/settings-store.ts`
- Create: `test/settings/settings-store.test.ts`

**Step 1: Write the failing test**

Create `test/settings/settings-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsStore } from '../../src/settings/settings-store.js';
import * as fs from 'fs';
import * as path from 'path';

describe('SettingsStore', () => {
  const testPath = path.join(process.cwd(), 'test-settings.json');

  afterEach(() => {
    try { fs.unlinkSync(testPath); } catch {}
  });

  describe('homeCategory', () => {
    it('should return undefined when no home category is set', () => {
      const store = new SettingsStore(testPath);
      expect(store.getHomeCategory()).toBeUndefined();
    });

    it('should save and retrieve home category', () => {
      const store = new SettingsStore(testPath);
      store.setHomeCategory('guild-1', 'category-1');
      expect(store.getHomeCategory()).toEqual({ guildId: 'guild-1', categoryId: 'category-1' });
    });

    it('should persist home category across instances', () => {
      const store1 = new SettingsStore(testPath);
      store1.setHomeCategory('guild-1', 'category-1');

      const store2 = new SettingsStore(testPath);
      expect(store2.getHomeCategory()).toEqual({ guildId: 'guild-1', categoryId: 'category-1' });
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test:run test/settings/settings-store.test.ts`
Expected: FAIL — `getHomeCategory` and `setHomeCategory` don't exist

**Step 3: Write minimal implementation**

In `src/settings/settings-store.ts`:

1. Add to `SettingsData` interface:
```typescript
interface SettingsData {
  models: Record<string, string>;
  allowedTools: Record<string, string[]>;
  homeCategory?: { guildId: string; categoryId: string };
}
```

2. Add getter/setter methods to the class:
```typescript
getHomeCategory(): { guildId: string; categoryId: string } | undefined {
  return this.data.homeCategory;
}

setHomeCategory(guildId: string, categoryId: string): void {
  this.data.homeCategory = { guildId, categoryId };
  this.save();
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test:run test/settings/settings-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/settings/settings-store.ts test/settings/settings-store.test.ts
git commit -m "feat: add homeCategory to SettingsStore"
```

---

### Task 2: Add /init slash command

**Files:**
- Modify: `src/bot/commands.ts`
- Modify: `test/bot/commands.test.ts`

**Step 1: Write the failing test**

Add to `test/bot/commands.test.ts`:

```typescript
// Add mockSettings to mocks at top:
const mockSettings = {
  setHomeCategory: vi.fn(),
};

// Update constructor call:
// commandHandler = new CommandHandler(mockClaudeManager as any, allowedUserId, mockSettings as any);
```

Add test case inside `describe('getCommands')`:
```typescript
it('should include init command', () => {
  const commands = commandHandler.getCommands();
  const initCmd = commands.find((c: any) => c.name === 'init');
  expect(initCmd).toBeDefined();
});
```

Add test case inside `describe('handleInteraction')`:
```typescript
it('should handle init command for authorized user', async () => {
  const mockInteraction = {
    isChatInputCommand: () => true,
    user: { id: allowedUserId },
    channelId: 'channel-123',
    commandName: 'init',
    channel: { parentId: 'category-456', parent: { name: 'My Projects' } },
    guild: { id: 'guild-789' },
    reply: vi.fn(),
  };

  await commandHandler.handleInteraction(mockInteraction);

  expect(mockSettings.setHomeCategory).toHaveBeenCalledWith('guild-789', 'category-456');
  expect(mockInteraction.reply).toHaveBeenCalledWith(
    expect.stringContaining('My Projects')
  );
});

it('should reject init when channel has no category', async () => {
  const mockInteraction = {
    isChatInputCommand: () => true,
    user: { id: allowedUserId },
    channelId: 'channel-123',
    commandName: 'init',
    channel: { parentId: null, parent: null },
    guild: { id: 'guild-789' },
    reply: vi.fn(),
  };

  await commandHandler.handleInteraction(mockInteraction);

  expect(mockSettings.setHomeCategory).not.toHaveBeenCalled();
  expect(mockInteraction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ ephemeral: true })
  );
});
```

**Step 2: Run test to verify it fails**

Run: `bun run test:run test/bot/commands.test.ts`
Expected: FAIL — constructor doesn't accept settings, no init command

**Step 3: Write minimal implementation**

In `src/bot/commands.ts`:

1. Add import and constructor param:
```typescript
import type { SettingsStore } from '../settings/settings-store.js';

// In constructor:
constructor(
  private claudeManager: ClaudeManager,
  private allowedUserId: string,
  private settings?: SettingsStore,
) {
```

2. Add command definition to `getCommands()`:
```typescript
new SlashCommandBuilder()
  .setName("init")
  .setDescription("Set this channel's category as the home for startup links"),
```

3. Add handler in `handleInteraction()`:
```typescript
if (interaction.commandName === "init") {
  const categoryId = interaction.channel?.parentId;
  if (!categoryId) {
    await interaction.reply({ content: "This channel is not in a category.", ephemeral: true });
    return;
  }
  const guildId = interaction.guild?.id;
  if (!guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }
  this.settings?.setHomeCategory(guildId, categoryId);
  const categoryName = interaction.channel?.parent?.name || 'Unknown';
  await interaction.reply(`Home category set to **${categoryName}**. Startup messages will now include channel links from this category.`);
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test:run test/bot/commands.test.ts`
Expected: PASS (update command count assertion from 5 to 6, and update the /add index from 4 to match)

**Step 5: Commit**

```bash
git add src/bot/commands.ts test/bot/commands.test.ts
git commit -m "feat: add /init slash command"
```

---

### Task 3: Pass SettingsStore through to CommandHandler

**Files:**
- Modify: `src/bot/client.ts`

**Step 1: Update DiscordBot constructor to accept and pass SettingsStore**

In `src/bot/client.ts`, the constructor already receives `claudeManager` and `allowedUserId`. We need to also accept `settings` and pass it to `CommandHandler`.

```typescript
import type { SettingsStore } from '../settings/settings-store.js';

// In constructor:
constructor(
  private claudeManager: ClaudeManager,
  private allowedUserId: string,
  private settings?: SettingsStore,
) {
  // ...
  this.commandHandler = new CommandHandler(claudeManager, allowedUserId, settings);
}
```

**Step 2: Update `src/index.ts` to pass settings to DiscordBot**

```typescript
const bot = new DiscordBot(claudeManager, config.allowedUserId, settings);
```

**Step 3: Run all tests**

Run: `bun run test:run`
Expected: PASS (client test mock doesn't care about extra param)

**Step 4: Commit**

```bash
git add src/bot/client.ts src/index.ts
git commit -m "feat: wire SettingsStore through to CommandHandler"
```

---

### Task 4: Add channel links to startup DM

**Files:**
- Modify: `src/bot/client.ts`

**Step 1: Expand the `ready` handler**

Replace the startup DM block (lines 67-73 of `src/bot/client.ts`) with:

```typescript
// Send startup announcement to allowed user
try {
  const user = await this.client.users.fetch(this.allowedUserId);
  let startupMsg = `🚀 **Bot is online!**\nLogged in as ${this.client.user?.tag}`;

  // Add channel links if home category is configured
  const home = this.settings?.getHomeCategory();
  if (home) {
    try {
      const guild = await this.client.guilds.fetch(home.guildId);
      const channels = await guild.channels.fetch();
      const categoryChannels = channels
        .filter((ch): ch is NonNullable<typeof ch> =>
          ch !== null && ch.parentId === home.categoryId && ch.isTextBased() && !ch.isThread()
        )
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

      if (categoryChannels.size > 0) {
        const links = categoryChannels.map(ch => `<#${ch.id}>`).join('  ');
        startupMsg += `\n\n📂 **Projects:**\n${links}`;
      }
    } catch (error) {
      console.error("Failed to fetch home category channels:", error);
    }
  }

  startupMsg += `\n\nReady to assist with Claude Code sessions.`;
  await user.send(startupMsg);
} catch (error) {
  console.error("Failed to send startup DM:", error);
}
```

**Step 2: Manually test** (bot owner runs the bot — we cannot run it per CLAUDE.md restrictions)

Verify:
- Without `/init` set: DM looks the same as before (no channel links)
- After `/init`: DM includes clickable channel links from the category

**Step 3: Commit**

```bash
git add src/bot/client.ts
git commit -m "feat: include channel links in startup DM"
```

---

### Task 5: Run all tests and final verification

**Step 1: Run full test suite**

Run: `bun run test:run`
Expected: All tests pass

**Step 2: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "fix: test adjustments for init command feature"
```
