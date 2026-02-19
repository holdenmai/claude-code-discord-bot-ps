import { SlashCommandBuilder, REST, Routes } from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';

export class CommandHandler {
  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string
  ) {}

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

    if (interaction.commandName === "model") {
      const channelId = interaction.channelId;
      const model = interaction.options.getString("name");
      this.claudeManager.setModel(channelId, model);
      await interaction.reply(`Model set to **${model}** for this channel.`);
    }
  }
}