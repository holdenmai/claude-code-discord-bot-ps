import { SlashCommandBuilder, REST, Routes, ChannelType, PermissionFlagsBits } from "discord.js";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { ClaudeManager } from '../claude/manager.js';

export class CommandHandler {
  private baseFolder: string;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string
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
              { name: "Sonnet (default)", value: "sonnet" },
              { name: "Opus", value: "opus" },
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
        .setName("update")
        .setDescription("Update the bot by pulling latest changes and restarting"),
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

    if (interaction.commandName === "add") {
      await this.handleAddCommand(interaction);
    }

    if (interaction.commandName === "update") {
      await this.handleUpdateCommand(interaction);
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