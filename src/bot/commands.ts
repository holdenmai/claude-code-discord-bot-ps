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
        .setName("file")
        .setDescription("Send a file from the project or Claude directory to chat")
        .addStringOption((option: any) =>
          option
            .setName("path")
            .setDescription("File path (relative to project folder or absolute)")
            .setRequired(true)
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
    // Handle autocomplete for /add command
    if (interaction.isAutocomplete?.()) {
      if (interaction.commandName === "add") {
        await this.handleAddAutocomplete(interaction);
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
    if (this.instanceRouter) {
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
      const matches = this.findFileByName(claudeHomeDir, projectDir, filePath);

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
  private findFileByName(claudeHomeDir: string, projectDir: string, fileName: string): string[] {
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

    // Then search the rest of the project
    this.walkDir(projectDir, fileName, matches, new Set([".claude"]));

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
}