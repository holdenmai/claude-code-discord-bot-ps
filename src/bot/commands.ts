import { SlashCommandBuilder, REST, Routes, ChannelType, PermissionFlagsBits } from "discord.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, execSync } from "child_process";
import type { ClaudeManager } from '../claude/manager.js';
import type { SettingsStore } from '../settings/settings-store.js';
import type { InstanceRouter } from '../routing/instance-router.js';

export class CommandHandler {
  private baseFolder: string;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string,
    private settings?: SettingsStore,
    private instanceRouter?: InstanceRouter,
  ) {
    this.baseFolder = process.env.BASE_FOLDER || '';
  }

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the current Claude Code session"),
      new SlashCommandBuilder()
        .setName("kill")
        .setDescription("Kill the currently running Claude Code process"),
      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Set the Claude model for this channel")
        .addStringOption((option: any) =>
          option
            .setName("name")
            .setDescription("Model to use")
            .setRequired(true)
            .addChoices(
              { name: "Sonnet", value: "sonnet" },
              { name: "Opus (default)", value: "opus" },
              { name: "Haiku", value: "haiku" },
            )
        ),
      new SlashCommandBuilder()
        .setName("killall")
        .setDescription("Kill all running Claude Code processes"),
      new SlashCommandBuilder()
        .setName("add")
        .setDescription("Create a channel for a project folder")
        .addStringOption((option: any) =>
          option
            .setName("folder")
            .setDescription("Project folder name")
            .setRequired(true)
            .setAutocomplete(true)
        ),
      new SlashCommandBuilder()
        .setName("plan")
        .setDescription("Toggle plan mode for this channel (read-only, no edits)"),
      new SlashCommandBuilder()
        .setName("update")
        .setDescription("Update the bot by pulling latest changes and restarting"),
      new SlashCommandBuilder()
        .setName("init")
        .setDescription("Set this channel's category as the home for startup links"),
      new SlashCommandBuilder()
        .setName("shortcut")
        .setDescription("Manage custom !command shortcuts")
        .addSubcommand((sub: any) =>
          sub
            .setName("add")
            .setDescription("Add a custom shortcut")
            .addStringOption((o: any) => o.setName("name").setDescription("Command name (used as !name)").setRequired(true))
            .addStringOption((o: any) => o.setName("prompt").setDescription("Prompt when used without extra text").setRequired(true))
            .addStringOption((o: any) => o.setName("prompt_with_message").setDescription("Prompt when extra text given (use {message} for the text)").setRequired(false))
            .addBooleanOption((o: any) => o.setName("global").setDescription("Global shortcut (default: repo-specific)").setRequired(false))
        )
        .addSubcommand((sub: any) =>
          sub
            .setName("remove")
            .setDescription("Remove a custom shortcut")
            .addStringOption((o: any) => o.setName("name").setDescription("Command name to remove").setRequired(true))
            .addBooleanOption((o: any) => o.setName("global").setDescription("Remove from global (default: repo-specific)").setRequired(false))
        )
        .addSubcommand((sub: any) =>
          sub
            .setName("list")
            .setDescription("List all shortcuts for this channel")
        ),
      new SlashCommandBuilder()
        .setName("sync")
        .setDescription("Merge main into all active worktrees for this project"),
      new SlashCommandBuilder()
        .setName("end")
        .setDescription("End a worktree session: push branch, remove worktree, lock thread"),
      new SlashCommandBuilder()
        .setName("adopt")
        .setDescription("Adopt an external Claude CLI session into a new channel")
        .addStringOption((option: any) =>
          option
            .setName("session")
            .setDescription("Session to adopt (search by path)")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((option: any) =>
          option
            .setName("name")
            .setDescription("Custom channel name (defaults to folder name)")
            .setRequired(false)
        ),
      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show a summary of recent activity across all project channels"),
      new SlashCommandBuilder()
        .setName("todo")
        .setDescription("Manage per-channel todo notes")
        .addSubcommand((sub: any) =>
          sub
            .setName("add")
            .setDescription("Add a todo to this channel")
            .addStringOption((o: any) => o.setName("text").setDescription("Todo text").setRequired(true))
        )
        .addSubcommand((sub: any) =>
          sub
            .setName("list")
            .setDescription("Show todos for this channel")
        )
        .addSubcommand((sub: any) =>
          sub
            .setName("done")
            .setDescription("Toggle a todo's completion status")
            .addIntegerOption((o: any) => o.setName("number").setDescription("Todo number from the list").setRequired(true))
        )
        .addSubcommand((sub: any) =>
          sub
            .setName("clear")
            .setDescription("Remove completed todos")
        ),
      new SlashCommandBuilder()
        .setName("pause")
        .setDescription("Pause the current session with a name (next message starts fresh)")
        .addStringOption((option: any) =>
          option
            .setName("name")
            .setDescription("Name for this paused session")
            .setRequired(true)
        ),
      new SlashCommandBuilder()
        .setName("resume")
        .setDescription("Resume a previously paused session")
        .addStringOption((option: any) =>
          option
            .setName("name")
            .setDescription("Name of the paused session to resume")
            .setRequired(true)
            .setAutocomplete(true)
        ),
      new SlashCommandBuilder()
        .setName("file")
        .setDescription("Send a file from the project or Claude directory to chat")
        .addStringOption((option: any) =>
          option
            .setName("path")
            .setDescription("File path (relative to project folder or absolute)")
            .setRequired(true)
        )
        .addBooleanOption((option: any) =>
          option
            .setName("include_worktrees")
            .setDescription("Include .worktrees/ directory in search (default: false)")
            .setRequired(false)
        ),
    ];
  }

  async registerCommands(token: string, clientId: string): Promise<void> {
    const rest = new REST().setToken(token);

    try {
      await rest.put(Routes.applicationCommands(clientId), {
        body: this.getCommands(),
      });
      console.log("Successfully registered application commands.");
    } catch (error) {
      console.error(error);
    }
  }

  async handleInteraction(interaction: any): Promise<void> {
    // Handle autocomplete
    if (interaction.isAutocomplete?.()) {
      if (interaction.commandName === "add") {
        await this.handleAddAutocomplete(interaction);
      } else if (interaction.commandName === "adopt") {
        await this.handleAdoptAutocomplete(interaction);
      } else if (interaction.commandName === "resume") {
        await this.handleResumeAutocomplete(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.user.id !== this.allowedUserId) {
      await interaction.reply({
        content: "You are not authorized to use this bot.",
        ephemeral: true,
      });
      return;
    }

    // Multi-instance guard: skip if another instance owns this channel
    // Read-only commands bypass this guard — they don't spawn Claude processes
    const readOnlyCommands = new Set(["status", "todo"]);
    if (this.instanceRouter && !readOnlyCommands.has(interaction.commandName)) {
      const channel = interaction.channel;
      const isThread = channel?.isThread?.();
      const routingId = isThread ? (channel.parent?.id || interaction.channelId) : interaction.channelId;
      const delay = this.instanceRouter.getDelay(routingId);
      if (delay === Infinity) {
        await interaction.reply({
          content: `This channel is handled by another instance.`,
          ephemeral: true,
        });
        return;
      }
    }

    if (interaction.commandName === "clear") {
      const channelId = interaction.channelId;
      this.claudeManager.clearSession(channelId);

      await interaction.reply(
        "Session cleared! Next message will start a new Claude Code session."
      );
    }

    if (interaction.commandName === "kill") {
      const channelId = interaction.channelId;
      if (this.claudeManager.hasActiveProcess(channelId)) {
        this.claudeManager.killActiveProcess(channelId);
        await interaction.reply("Killed the running Claude Code process. Session preserved — next message will resume.");
      } else {
        await interaction.reply({ content: "No active process in this channel.", ephemeral: true });
      }
    }

    if (interaction.commandName === "killall") {
      const count = this.claudeManager.killAllProcesses();
      await interaction.reply(`Killed ${count} running process${count !== 1 ? "es" : ""}.`);
    }

    if (interaction.commandName === "model") {
      const channelId = interaction.channelId;
      const model = interaction.options.getString("name");
      this.claudeManager.setModel(channelId, model);
      await interaction.reply(`Model set to **${model}** for this channel.`);
    }

    if (interaction.commandName === "plan") {
      const channelId = interaction.channelId;
      const enabled = this.claudeManager.togglePlanMode(channelId);
      const icon = enabled ? "📋" : "✏️";
      const msg = enabled
        ? " Claude can explore and propose changes but won't edit files."
        : " Claude can now edit files. Tell Claude to implement the plan to apply changes.";
      await interaction.reply(`${icon} Plan mode **${enabled ? "enabled" : "disabled"}** for this channel.${msg}`);
    }

    if (interaction.commandName === "add") {
      await this.handleAddCommand(interaction);
    }

    if (interaction.commandName === "update") {
      await this.handleUpdateCommand(interaction);
    }

    if (interaction.commandName === "shortcut") {
      await this.handleShortcutCommand(interaction);
    }

    if (interaction.commandName === "sync") {
      await this.handleSyncCommand(interaction);
    }

    if (interaction.commandName === "end") {
      await this.handleEndCommand(interaction);
    }

    if (interaction.commandName === "file") {
      await this.handleFileCommand(interaction);
    }

    if (interaction.commandName === "status") {
      await this.handleStatusCommand(interaction);
    }

    if (interaction.commandName === "todo") {
      await this.handleTodoCommand(interaction);
    }

    if (interaction.commandName === "adopt") {
      await this.handleAdoptCommand(interaction);
    }

    if (interaction.commandName === "pause") {
      await this.handlePauseCommand(interaction);
    }

    if (interaction.commandName === "resume") {
      await this.handleResumeCommand(interaction);
    }

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
  }

  /**
   * Autocomplete handler for /add - lists folders in BASE_FOLDER
   */
  private async handleAddAutocomplete(interaction: any): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();

    try {
      const entries = fs.readdirSync(this.baseFolder, { withFileTypes: true });
      const folders = entries
        .filter((e: fs.Dirent) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e: fs.Dirent) => e.name)
        .filter((name: string) => name.toLowerCase().includes(focused))
        .slice(0, 25); // Discord max 25 autocomplete results

      await interaction.respond(
        folders.map((name: string) => ({ name, value: name }))
      );
    } catch (error) {
      console.error("Error reading folders for autocomplete:", error);
      await interaction.respond([]);
    }
  }

  /**
   * Create a Discord channel for the selected project folder
   */
  private async handleAddCommand(interaction: any): Promise<void> {
    const folderName = interaction.options.getString("folder");
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }

    // Create the folder if it doesn't exist
    const folderPath = path.join(this.baseFolder, folderName);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      console.log(`Created project folder: ${folderPath}`);
    }

    // Get the category of the channel where command was run
    const sourceChannel = interaction.channel;
    const categoryId = sourceChannel?.parentId || null;

    // Check if a channel with this name already exists in the category
    const existing = guild.channels.cache.find(
      (ch: any) => ch.name === folderName && ch.parentId === categoryId
    );
    if (existing) {
      await interaction.reply({ content: `Channel <#${existing.id}> already exists for \`${folderName}\`.`, ephemeral: true });
      return;
    }

    try {
      const newChannel = await guild.channels.create({
        name: folderName,
        type: ChannelType.GuildText,
        parent: categoryId,
      });

      await interaction.reply(`Created <#${newChannel.id}> for project \`${folderName}\``);
    } catch (error) {
      console.error("Error creating channel:", error);
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.reply({ content: `Failed to create channel: ${msg}`, ephemeral: true });
    }
  }

  /**
   * Extract the real cwd from the first line of the most recent session JSONL.
   * Claude CLI stores the original working directory in every session entry.
   */
  private extractCwdFromSession(claudeProjectDir: string): { cwd: string; sessionId: string } | null {
    let latestFile: string | undefined;
    let latestTime = 0;
    try {
      for (const file of fs.readdirSync(claudeProjectDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const stat = fs.statSync(path.join(claudeProjectDir, file));
        if (stat.mtimeMs > latestTime) {
          latestTime = stat.mtimeMs;
          latestFile = file;
        }
      }
    } catch { return null; }

    if (!latestFile) return null;

    try {
      const fd = fs.openSync(path.join(claudeProjectDir, latestFile), "r");
      const buf = Buffer.alloc(4096);
      fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString("utf-8").split("\n")[0]!;
      const parsed = JSON.parse(firstLine);
      if (parsed.cwd) {
        return { cwd: parsed.cwd, sessionId: latestFile.replace(".jsonl", "") };
      }
    } catch { /* ignore parse errors */ }

    return null;
  }

  /**
   * Autocomplete handler for /adopt - lists orphan Claude CLI sessions
   */
  private async handleAdoptAutocomplete(interaction: any): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();

    try {
      const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");
      if (!fs.existsSync(claudeProjectsDir)) {
        await interaction.respond([]);
        return;
      }

      const entries = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
      const baseFolderNorm = path.resolve(this.baseFolder);

      const results: { name: string; value: string }[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectDir = path.join(claudeProjectsDir, entry.name);
        const info = this.extractCwdFromSession(projectDir);
        if (!info) continue;

        const resolvedCwd = path.resolve(info.cwd);

        // Skip projects under BASE_FOLDER (already manageable via /add)
        if (resolvedCwd.startsWith(baseFolderNorm + path.sep) || resolvedCwd === baseFolderNorm) continue;

        // Filter by search term
        if (!info.cwd.toLowerCase().includes(focused)) continue;

        // Discord autocomplete: name max 100 chars, value max 100 chars
        const shortName = info.cwd.length > 100 ? "..." + info.cwd.slice(-97) : info.cwd;
        results.push({ name: shortName, value: entry.name });

        if (results.length >= 25) break;
      }

      await interaction.respond(results);
    } catch (error) {
      console.error("Error in adopt autocomplete:", error);
      await interaction.respond([]);
    }
  }

  /**
   * Handle /adopt command - create a channel for an external Claude CLI session
   */
  private async handleAdoptCommand(interaction: any): Promise<void> {
    const mangledName = interaction.options.getString("session");
    const customName = interaction.options.getString("name");
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      return;
    }

    // Extract the real path from the session file
    const claudeProjectDir = path.join(os.homedir(), ".claude", "projects", mangledName);
    const info = this.extractCwdFromSession(claudeProjectDir);
    if (!info) {
      await interaction.reply({ content: "Could not read session data for this project.", ephemeral: true });
      return;
    }

    const realPath = info.cwd;
    if (!fs.existsSync(realPath)) {
      await interaction.reply({ content: `Directory not found: \`${realPath}\``, ephemeral: true });
      return;
    }

    // Determine channel name: custom name, or last path segment sanitized for Discord
    const channelName = customName || path.basename(realPath).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");

    // Check for existing channel
    const sourceChannel = interaction.channel;
    const categoryId = sourceChannel?.parentId || null;
    const existing = guild.channels.cache.find(
      (ch: any) => ch.name === channelName && ch.parentId === categoryId
    );
    if (existing) {
      await interaction.reply({ content: `Channel <#${existing.id}> already exists.`, ephemeral: true });
      return;
    }

    try {
      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
      });

      // Persist the directory override so it survives restarts
      this.settings?.setDirectoryOverride(newChannel.id, realPath);
      this.claudeManager.setWorkingDirOverride(newChannel.id, realPath);

      // Link the session
      this.claudeManager.setSessionFromAdopt(newChannel.id, info.sessionId, channelName);

      let reply = `Created <#${newChannel.id}> → \`${realPath}\``;
      reply += `\nLinked session: \`${info.sessionId.slice(0, 8)}...\``;
      await interaction.reply(reply);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.reply({ content: `Failed to create channel: ${msg}`, ephemeral: true });
    }
  }

  /**
   * Handle /status command - show summary of recent activity across project channels.
   */
  private async handleStatusCommand(interaction: any): Promise<void> {
    const home = this.settings?.getHomeCategory();
    if (!home) {
      await interaction.reply({ content: "No home category set. Run `/init` in your project category first.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sessions = this.claudeManager.getAllSessions();
    if (sessions.length === 0) {
      await interaction.editReply("No sessions found.");
      return;
    }

    // Get channels in home category to filter
    let homeChanelIds: Set<string>;
    try {
      const guild = await interaction.client.guilds.fetch(home.guildId);
      const channels = await guild.channels.fetch();
      const homeChannels = channels.filter(
        (ch: any): ch is NonNullable<typeof ch> =>
          ch !== null && ch.parentId === home.categoryId
      );
      homeChanelIds = new Set(homeChannels.map((ch: any) => ch.id));

      // Also include threads under those channels
      for (const ch of homeChannels.values()) {
        if ('threads' in ch) {
          const threads = await (ch as any).threads.fetchActive();
          for (const [id] of threads.threads) {
            homeChanelIds.add(id);
          }
        }
      }
    } catch (error) {
      await interaction.editReply("Failed to fetch home category channels.");
      return;
    }

    const filtered = sessions.filter(s => homeChanelIds.has(s.channelId));
    if (filtered.length === 0) {
      await interaction.editReply("No sessions found in the home category.");
      return;
    }

    const now = Date.now();
    const lines: string[] = [];
    for (const s of filtered.slice(0, 15)) {
      const ago = this.formatRelativeTime(now - s.lastUsed);
      const channel = `<#${s.channelId}>`;
      let meta = ago;
      if (s.lastNumTurns) meta += ` — ${s.lastNumTurns} turns`;
      if (s.lastCostUsd) meta += `, $${s.lastCostUsd.toFixed(2)}`;

      let line = `${channel} (${meta})`;

      // Show recent prompt/result history for context
      const history = this.claudeManager.getPromptHistory(s.channelId, 5);
      if (history.length > 0) {
        for (const h of history) {
          const prompt = h.prompt.slice(0, 80).replace(/\n/g, " ");
          line += `\n> 💬 ${prompt}${h.prompt.length > 80 ? "..." : ""}`;
          if (h.resultSummary) {
            const result = h.resultSummary.slice(0, 80).replace(/\n/g, " ");
            line += `\n> ✅ ${result}${h.resultSummary.length > 80 ? "..." : ""}`;
          }
        }
      } else if (s.lastSummary) {
        // Fallback to single summary if no history yet
        const summary = s.lastSummary.slice(0, 120).replace(/\n/g, " ");
        line += `\n> ${summary}${s.lastSummary.length > 120 ? "..." : ""}`;
      }
      lines.push(line);
    }

    const content = `📊 **Project Status**\n\n${lines.join("\n\n")}`;

    // Discord message limit is 2000 chars for ephemeral
    if (content.length > 2000) {
      await interaction.editReply(content.slice(0, 1997) + "...");
    } else {
      await interaction.editReply(content);
    }
  }

  private formatRelativeTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  /**
   * Handle /todo command - per-channel todo notes.
   */
  private async handleTodoCommand(interaction: any): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;
    const channel = interaction.channel;
    const isThread = channel?.isThread?.();
    const parentChannelId = isThread ? channel.parentId : undefined;

    if (sub === "add") {
      const text = interaction.options.getString("text");
      this.claudeManager.addTodo(channelId, text, parentChannelId);
      await interaction.reply({ content: `✅ Added: ${text}`, ephemeral: true });

    } else if (sub === "list") {
      // From parent channel: show own todos + child thread todos
      // From thread: show only that thread's todos
      const todos = isThread
        ? this.claudeManager.getTodos(channelId)
        : this.claudeManager.getChannelAndChildTodos(channelId);

      if (todos.length === 0) {
        await interaction.reply({ content: "No todos for this channel.", ephemeral: true });
        return;
      }

      const channelName = isThread
        ? channel.parent?.name || "channel"
        : channel?.name || "channel";

      // Group by channel for parent view
      const lines: string[] = [];
      let currentGroup = "";
      let idx = 1;
      for (const todo of todos) {
        if (!isThread && todo.channelId !== channelId) {
          // Thread todo — group header
          const threadLabel = `<#${todo.channelId}>`;
          if (threadLabel !== currentGroup) {
            currentGroup = threadLabel;
            lines.push(`\n**${threadLabel}**`);
          }
        }
        const check = todo.completed ? "☑" : "☐";
        lines.push(`${idx}. ${check} ${todo.text}`);
        idx++;
      }

      const header = `📝 **Todos for #${channelName}**\n`;
      await interaction.reply({ content: header + lines.join("\n"), ephemeral: true });

    } else if (sub === "done") {
      const num = interaction.options.getInteger("number");
      const todos = isThread
        ? this.claudeManager.getTodos(channelId)
        : this.claudeManager.getChannelAndChildTodos(channelId);

      if (num < 1 || num > todos.length) {
        await interaction.reply({ content: `Invalid number. Use 1-${todos.length}.`, ephemeral: true });
        return;
      }

      const todo = todos[num - 1]!;
      // Toggle: if completed, uncomplete; if not, complete
      if (todo.completed) {
        this.claudeManager.uncompleteTodo(todo.id);
        await interaction.reply({ content: `☐ Uncompleted: ${todo.text}`, ephemeral: true });
      } else {
        this.claudeManager.completeTodo(todo.id);
        await interaction.reply({ content: `☑ Done: ${todo.text}`, ephemeral: true });
      }

    } else if (sub === "clear") {
      const count = this.claudeManager.clearCompletedTodos(channelId);
      await interaction.reply({ content: `Cleared ${count} completed todo${count !== 1 ? "s" : ""}.`, ephemeral: true });
    }
  }

  /**
   * Handle /sync command - merge main into all active worktrees for this project.
   */
  private async handleSyncCommand(interaction: any): Promise<void> {
    const channel = interaction.channel;
    const isThread = channel?.isThread?.();
    const channelName = isThread
      ? channel.parent?.name || "default"
      : channel?.name || "default";

    const repoDir = path.join(this.baseFolder, channelName);
    if (!fs.existsSync(repoDir)) {
      await interaction.reply({ content: `Project folder not found: \`${channelName}\``, ephemeral: true });
      return;
    }

    await interaction.deferReply();

    // First, fetch latest main in the main repo
    try {
      execSync("git fetch origin main", { cwd: repoDir, stdio: "pipe" });
    } catch {
      // fetch might fail if no remote, continue anyway
    }

    // List active worktrees
    let worktreeOutput: string;
    try {
      worktreeOutput = execSync("git worktree list --porcelain", { cwd: repoDir, stdio: "pipe" }).toString();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Failed to list worktrees: ${msg}`);
      return;
    }

    // Parse worktree list — each entry starts with "worktree <path>"
    const worktrees: { path: string; branch: string }[] = [];
    const blocks = worktreeOutput.split("\n\n").filter(b => b.trim());
    for (const block of blocks) {
      const lines = block.split("\n");
      const wtLine = lines.find(l => l.startsWith("worktree "));
      const branchLine = lines.find(l => l.startsWith("branch "));
      if (wtLine && branchLine) {
        const wtPath = wtLine.slice("worktree ".length).trim();
        const branch = branchLine.slice("branch refs/heads/".length).trim();
        // Skip the main worktree (the repo itself)
        if (wtPath === repoDir || wtPath === repoDir.replace(/\//g, "\\")) continue;
        worktrees.push({ path: wtPath, branch });
      }
    }

    if (worktrees.length === 0) {
      await interaction.editReply("No active worktrees found for this project.");
      return;
    }

    const results: string[] = [];
    for (const wt of worktrees) {
      const name = path.basename(wt.path);
      try {
        const output = execSync("git merge main --no-edit", { cwd: wt.path, stdio: "pipe" }).toString().trim();
        if (output.includes("Already up to date")) {
          results.push(`✅ **${name}** (\`${wt.branch}\`) — already up to date`);
        } else {
          results.push(`✅ **${name}** (\`${wt.branch}\`) — merged`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Abort the failed merge so the worktree isn't left in a conflict state
        try { execSync("git merge --abort", { cwd: wt.path, stdio: "pipe" }); } catch {}
        results.push(`❌ **${name}** (\`${wt.branch}\`) — merge conflict\n\`\`\`\n${msg.slice(0, 200)}\n\`\`\``);
      }
    }

    await interaction.editReply(`🔄 **Sync main → worktrees** (${channelName})\n\n${results.join("\n")}`);
  }

  /**
   * Handle /end command - push branch, remove worktree, lock thread.
   * Only works in threads that have an associated worktree.
   */
  private async handleEndCommand(interaction: any): Promise<void> {
    const channel = interaction.channel;

    if (!channel?.isThread?.()) {
      await interaction.reply({ content: "This command can only be used in a worktree thread.", ephemeral: true });
      return;
    }

    const parentName = channel.parent?.name || "default";
    const threadName = channel.name;
    const channelId = interaction.channelId;
    const repoDir = path.join(this.baseFolder, parentName);

    // Find the worktree
    const { getExistingWorktree } = await import("../utils/worktree.js");
    const wt = getExistingWorktree(this.baseFolder, parentName, threadName);
    if (!wt) {
      await interaction.reply({ content: "No worktree found for this thread.", ephemeral: true });
      return;
    }

    await interaction.deferReply();
    const steps: string[] = [];

    // Kill any active Claude process in this thread
    if (this.claudeManager.hasActiveProcess(channelId)) {
      this.claudeManager.killActiveProcess(channelId);
      steps.push("⏹️ Killed active Claude process");
    }

    // Check for uncommitted changes — abort if dirty
    try {
      const status = execSync("git status --porcelain", { cwd: wt.path, stdio: "pipe" }).toString().trim();
      if (status) {
        await interaction.editReply(
          `⚠️ **Outstanding changes in \`${wt.branch}\`** — please commit or discard before ending.\n\`\`\`\n${status.slice(0, 1500)}\n\`\`\``
        );
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Could not check worktree status: ${msg.slice(0, 200)}`);
      return;
    }

    // Push branch to origin
    try {
      execSync(`git push -u origin "${wt.branch}"`, { cwd: wt.path, stdio: "pipe" });
      steps.push(`📤 Pushed \`${wt.branch}\` to origin`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      steps.push(`⚠️ Push failed: ${msg.slice(0, 150)}`);
    }

    // Clear session data before removing the worktree
    this.claudeManager.clearSession(channelId);
    steps.push("🧹 Cleared session");

    // Remove the worktree
    try {
      execSync(`git worktree remove "${wt.path}" --force`, { cwd: repoDir, stdio: "pipe" });
      steps.push(`🗑️ Removed worktree at \`${path.basename(wt.path)}\``);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      steps.push(`⚠️ Worktree removal failed: ${msg.slice(0, 150)}`);
    }

    // Post summary before locking (can't send messages after lock)
    await interaction.editReply(`🏁 **Ending worktree session** (\`${wt.branch}\`)\n\n${steps.join("\n")}\n\n🔒 Locking thread...`);

    // Lock the thread
    try {
      await channel.setLocked(true, "Worktree session ended via /end");
      await channel.setArchived(true, "Worktree session ended via /end");
    } catch (error) {
      // May lack permissions — not critical
      console.error("Failed to lock/archive thread:", error);
    }
  }

  /**
   * Handle /shortcut command - manage custom !command shortcuts.
   */
  private async handleShortcutCommand(interaction: any): Promise<void> {
    if (!this.settings) {
      await interaction.reply({ content: "Settings not available.", ephemeral: true });
      return;
    }

    const channel = interaction.channel;
    const isThread = channel?.isThread?.();
    const channelName = isThread
      ? channel.parent?.name || "default"
      : channel?.name || "default";

    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const name = interaction.options.getString("name");
      const prompt = interaction.options.getString("prompt");
      const promptWithMessage = interaction.options.getString("prompt_with_message");
      const isGlobal = interaction.options.getBoolean("global") ?? false;
      this.settings.addCustomCommand(name, prompt, isGlobal ? undefined : channelName, promptWithMessage);
      const scope = isGlobal ? "global" : `**${channelName}**`;
      let desc = `Added shortcut \`!${name}\` → \`${prompt}\``;
      if (promptWithMessage) desc += `\nWith message: \`${promptWithMessage}\``;
      desc += ` (${scope})`;
      await interaction.reply(desc);
    } else if (sub === "remove") {
      const name = interaction.options.getString("name");
      const isGlobal = interaction.options.getBoolean("global") ?? false;
      const removed = this.settings.removeCustomCommand(name, isGlobal ? undefined : channelName);
      if (removed) {
        await interaction.reply(`Removed shortcut \`!${name}\``);
      } else {
        await interaction.reply({ content: `Shortcut \`!${name}\` not found.`, ephemeral: true });
      }
    } else if (sub === "list") {
      const { global, repo } = this.settings.listCustomCommands(channelName);
      const lines: string[] = [];
      if (global.length > 0) {
        lines.push("**Global:**");
        for (const c of global) {
          let line = `  \`!${c.name}\` → \`${c.prompt}\``;
          if (c.promptWithMessage) line += ` | with msg: \`${c.promptWithMessage}\``;
          lines.push(line);
        }
      }
      if (repo.length > 0) {
        lines.push(`**${channelName}:**`);
        for (const c of repo) {
          let line = `  \`!${c.name}\` → \`${c.prompt}\``;
          if (c.promptWithMessage) line += ` | with msg: \`${c.promptWithMessage}\``;
          lines.push(line);
        }
      }
      if (lines.length === 0) lines.push("No shortcuts configured.");
      await interaction.reply(lines.join("\n"));
    }
  }

  /**
   * Handle /file command - send a file's contents to Discord.
   * Supports full paths, relative paths, and bare filenames.
   * Bare filenames search ~/.claude/ first, then the project directory.
   */
  private async handleFileCommand(interaction: any): Promise<void> {
    const filePath = interaction.options.getString("path");
    const includeWorktrees = interaction.options.getBoolean("include_worktrees") ?? false;
    const channel = interaction.channel;

    // Determine the project folder for this channel
    const isThread = channel?.isThread?.();
    const channelName = isThread
      ? channel.parent?.name || "default"
      : channel?.name || "default";
    const projectDir = path.resolve(path.join(this.baseFolder, channelName));

    // Allowed directories: project dir + global ~/.claude/
    const claudeHomeDir = path.resolve(path.join(os.homedir(), ".claude"));
    const allowedDirs = [projectDir, claudeHomeDir];

    // Determine if this is a bare filename (no directory separators)
    const isBareFilename = !filePath.includes("/") && !filePath.includes("\\") && !path.isAbsolute(filePath);

    let resolvedPath: string;

    if (isBareFilename) {
      // Search for the file: ~/.claude/ first, then project directory
      const matches = this.findFileByName(claudeHomeDir, projectDir, filePath, includeWorktrees);

      if (matches.length === 0) {
        await interaction.reply({
          content: `❌ File not found: \`${filePath}\`\nSearched in \`${claudeHomeDir}\` and \`${projectDir}\``,
          ephemeral: true,
        });
        return;
      }

      if (matches.length > 1) {
        const list = matches
          .map((m, i) => `${i + 1}. \`${this.displayPath(m, allowedDirs)}\``)
          .join("\n");
        await interaction.reply({
          content: `Multiple matches for \`${filePath}\`:\n${list}\n\nPlease use a more specific path.`,
          ephemeral: true,
        });
        return;
      }

      resolvedPath = matches[0]!;
    } else {
      // Resolve relative or absolute path
      resolvedPath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(path.join(projectDir, filePath));
    }

    // Security: file must be within an allowed directory
    const isAllowed = allowedDirs.some(dir =>
      resolvedPath.startsWith(dir + path.sep) || resolvedPath === dir
    );
    if (!isAllowed) {
      await interaction.reply({
        content: `❌ Access denied. File must be within the project or \`~/.claude/\``,
        ephemeral: true,
      });
      return;
    }

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      await interaction.reply({
        content: `❌ File not found: \`${resolvedPath}\``,
        ephemeral: true,
      });
      return;
    }

    // Check it's a file, not a directory
    const stats = fs.statSync(resolvedPath);
    if (!stats.isFile()) {
      await interaction.reply({
        content: `❌ Not a file: \`${resolvedPath}\``,
        ephemeral: true,
      });
      return;
    }

    // Size limit: 500KB
    const MAX_SIZE = 500 * 1024;
    if (stats.size > MAX_SIZE) {
      const sizeKB = Math.round(stats.size / 1024);
      await interaction.reply({
        content: `❌ File too large: ${sizeKB}KB (limit: 500KB)\n\`${resolvedPath}\``,
        ephemeral: true,
      });
      return;
    }

    // Send as attachment
    try {
      const fileName = path.basename(resolvedPath);
      const displayRelPath = this.displayPath(resolvedPath, allowedDirs);
      await interaction.reply({
        content: `📄 \`${displayRelPath}\``,
        files: [{ attachment: resolvedPath, name: fileName }],
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.reply({
        content: `❌ Failed to send file: ${msg}`,
        ephemeral: true,
      });
    }
  }

  /**
   * Build a readable display path relative to the best matching allowed directory.
   */
  private displayPath(filePath: string, allowedDirs: string[]): string {
    for (const dir of allowedDirs) {
      if (filePath.startsWith(dir + path.sep)) {
        const rel = path.relative(dir, filePath);
        // For ~/.claude/ files, prefix with ~/.claude/ for clarity
        if (dir.endsWith(".claude")) {
          return `~/.claude/${rel.replace(/\\/g, "/")}`;
        }
        return rel.replace(/\\/g, "/");
      }
    }
    return filePath;
  }

  /**
   * Recursively search for files matching a given filename.
   * Searches ~/.claude/ first, then the project directory.
   * Skips node_modules and .git directories.
   */
  private findFileByName(claudeHomeDir: string, projectDir: string, fileName: string, includeWorktrees: boolean = false): string[] {
    const matches: string[] = [];

    // Search ~/.claude/ first (plans, settings, etc.)
    if (fs.existsSync(claudeHomeDir)) {
      this.walkDir(claudeHomeDir, fileName, matches);
    }

    // Then search project's .claude/ directory
    const projectClaudeDir = path.join(projectDir, ".claude");
    if (fs.existsSync(projectClaudeDir)) {
      this.walkDir(projectClaudeDir, fileName, matches);
    }

    // Then search the rest of the project — skip .worktrees unless explicitly included
    const skipDirs = new Set([".claude"]);
    if (!includeWorktrees) skipDirs.add(".worktrees");
    this.walkDir(projectDir, fileName, matches, skipDirs);

    return matches;
  }

  /**
   * Walk a directory tree collecting files that match the target filename.
   */
  private walkDir(dir: string, targetName: string, results: string[], skipDirs?: Set<string>): void {
    const SKIP_ALWAYS = new Set(["node_modules", ".git", ".hg"]);
    const MAX_RESULTS = 20;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;

      if (entry.isDirectory()) {
        if (SKIP_ALWAYS.has(entry.name)) continue;
        if (skipDirs?.has(entry.name)) continue;
        this.walkDir(path.join(dir, entry.name), targetName, results);
      } else if (entry.isFile() && entry.name === targetName) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  /**
   * Handle /update command - git pull and restart the bot
   */
  private async handleUpdateCommand(interaction: any): Promise<void> {
    await interaction.reply("🔄 Pulling latest changes...");

    try {
      // Run git pull
      const gitPull = spawn("git", ["pull"], {
        cwd: process.cwd(),
        shell: true,
      });

      let output = "";
      let errorOutput = "";

      gitPull.stdout.on("data", (data) => {
        output += data.toString();
      });

      gitPull.stderr.on("data", (data) => {
        errorOutput += data.toString();
      });

      gitPull.on("close", async (code) => {
        if (code !== 0) {
          await interaction.editReply(`❌ Git pull failed:\n\`\`\`\n${errorOutput}\n\`\`\``);
          return;
        }

        await interaction.editReply(`✅ Updated successfully!\n\`\`\`\n${output}\n\`\`\`\n🔄 Restarting bot...`);

        // Give Discord time to send the message, then restart
        setTimeout(async () => {
          console.log("Restarting bot after update...");

          const cwd = process.cwd();
          const vbsPath = path.join(cwd, "restart.vbs");

          // Create a VBS script that launches cmd in a visible window
          const vbsContent = `
Set WshShell = CreateObject("WScript.Shell")
WScript.Sleep 2000
WshShell.CurrentDirectory = "${cwd.replace(/\\/g, "\\\\")}"
WshShell.Run "cmd /k bun run start", 1, False
`;
          fs.writeFileSync(vbsPath, vbsContent.trim());

          // Run the VBS script with wscript (doesn't block, creates independent process)
          spawn("wscript.exe", [vbsPath], {
            detached: true,
            stdio: "ignore",
          }).unref();

          console.log("Restart VBS script launched, exiting...");
          process.exit(0);
        }, 1000);
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`❌ Update failed: ${msg}`);
    }
  }

  private async handlePauseCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const name = interaction.options.getString("name");

    if (this.claudeManager.hasActiveProcess(channelId)) {
      await interaction.reply({
        content: "Cannot pause while a process is running. Use `/kill` first.",
        ephemeral: true,
      });
      return;
    }

    const success = this.claudeManager.pauseSession(channelId, name);
    if (success) {
      await interaction.reply(`Session paused as **${name}**. Next message will start a new session.`);
    } else {
      await interaction.reply({
        content: "No active session to pause in this channel.",
        ephemeral: true,
      });
    }
  }

  private async handleResumeCommand(interaction: any): Promise<void> {
    const channelId = interaction.channelId;
    const name = interaction.options.getString("name");
    const channelName = interaction.channel?.name || channelId;

    const success = this.claudeManager.resumeSession(channelId, name, channelName);
    if (success) {
      await interaction.reply(`Resumed session **${name}**. Next message will continue that session.`);
    } else {
      await interaction.reply({
        content: `No paused session named **${name}** in this channel.`,
        ephemeral: true,
      });
    }
  }

  private async handleResumeAutocomplete(interaction: any): Promise<void> {
    const focused = interaction.options.getFocused().toLowerCase();
    const channelId = interaction.channelId;

    try {
      const paused = this.claudeManager.getPausedSessions(channelId);
      const filtered = paused
        .filter(s => s.name.toLowerCase().includes(focused))
        .slice(0, 25);

      await interaction.respond(
        filtered.map(s => {
          const age = formatAge(s.pausedAt);
          return { name: `${s.name} (paused ${age})`, value: s.name };
        })
      );
    } catch {
      await interaction.respond([]);
    }
  }
}

function formatAge(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}