import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';
import { MessageQueue } from '../queue/message-queue.js';

export class DiscordBot {
  public client: Client; // Make public so MCP server can access it
  private commandHandler: CommandHandler;
  private mcpServer?: MCPPermissionServer;
  private messageQueue: MessageQueue;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // Add reactions for approval
      ],
    });

    this.commandHandler = new CommandHandler(claudeManager, allowedUserId);
    this.messageQueue = new MessageQueue();
    this.setupEventHandlers();
    this.setupCompletionCallback();
  }

  /**
   * Set the MCP server for handling approval reactions
   */
  setMCPServer(mcpServer: MCPPermissionServer): void {
    this.mcpServer = mcpServer;
  }

  /**
   * Wire up the completion callback so the queue advances after each run.
   */
  private setupCompletionCallback(): void {
    this.claudeManager.setOnCompleteCallback(async (channelId, success, originalMessage) => {
      // React on the original user message
      await this.messageQueue.markComplete(originalMessage, success);

      // Dequeue the next message for this channel
      const next = await this.messageQueue.dequeueNext(channelId);
      if (next) {
        await this.processMessage(next.message, channelId, next.channelName, next.prompt, next.imageUrls);
      }
    });
  }

  private setupEventHandlers(): void {
    this.client.once("ready", async () => {
      console.log(`Bot is ready! Logged in as ${this.client.user?.tag}`);
      await this.commandHandler.registerCommands(
        process.env.DISCORD_TOKEN!,
        this.client.user!.id
      );

      // Send startup announcement to allowed user
      try {
        const user = await this.client.users.fetch(this.allowedUserId);
        await user.send(`🚀 **Bot is online!**\nLogged in as ${this.client.user?.tag}\n\nReady to assist with Claude Code sessions.`);
      } catch (error) {
        console.error("Failed to send startup DM:", error);
      }
    });

    this.client.on("interactionCreate", async (interaction) => {
      // Handle button and select menu interactions
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        if (this.mcpServer) {
          const customId = interaction.customId;
          const pm = this.mcpServer.getPermissionManager();

          // AskUserQuestion buttons/menus
          if (customId.startsWith('q:') || customId.startsWith('qs:')) {
            if (pm.handleQuestionInteraction(interaction)) return;
          }

          // Tool approval buttons (Allow / Deny / Always Allow)
          if (customId.startsWith('approve:') || customId.startsWith('deny:') || customId.startsWith('always:')) {
            if (pm.handleApprovalInteraction(interaction)) return;
          }
        }
      }

      // Handle /clear — also clear the queue
      if (interaction.isCommand?.() && interaction.commandName === "clear") {
        await this.messageQueue.clearChannel(interaction.channelId);
      }

      await this.commandHandler.handleInteraction(interaction);
    });

    this.client.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });

    // Handle reactions for MCP approval
    this.client.on("messageReactionAdd", async (reaction, user) => {
      await this.handleReactionAdd(reaction, user);
    });
  }

  /**
   * Handle reaction add events for MCP approval
   */
  private async handleReactionAdd(reaction: any, user: any): Promise<void> {
    // Ignore bot reactions
    if (user.bot) return;

    // Only process reactions from the authorized user
    if (user.id !== this.allowedUserId) return;

    // Only process ✅ and ❌ reactions
    if (reaction.emoji.name !== '✅' && reaction.emoji.name !== '❌') return;

    console.log(`Discord: Reaction ${reaction.emoji.name} by ${user.id} on message ${reaction.message.id}`);

    // Pass to MCP server if available
    if (this.mcpServer) {
      const approved = reaction.emoji.name === '✅';
      this.mcpServer.getPermissionManager().handleApprovalReaction(
        reaction.message.channelId,
        reaction.message.id,
        user.id,
        approved
      );
    }
  }

  private async handleMessage(message: any): Promise<void> {
    if (message.author.bot) return;

    console.log("MESSAGE CREATED", message.id);

    if (message.author.id !== this.allowedUserId) {
      return;
    }

    const channelId = message.channelId;
    const channelName =
      message.channel && "name" in message.channel
        ? message.channel.name
        : "default";

    // Don't run in general channel
    if (channelName === "general") {
      return;
    }

    // Extract image attachments if any
    const imageAttachments = message.attachments
      ?.filter((att: any) => att.contentType?.startsWith("image/"))
      .map((att: any) => att.url) || [];

    // Try to enqueue — if the channel is busy, the message gets queued
    const wasQueued = await this.messageQueue.enqueue(channelId, message, channelName, message.content, imageAttachments);
    if (wasQueued) {
      console.log(`Channel ${channelId} is busy, message queued (queue length: ${this.messageQueue.getQueueLength(channelId)})`);
      return;
    }

    // Channel is free — process immediately
    await this.processMessage(message, channelId, channelName, message.content, imageAttachments);
  }

  /**
   * Shared processing logic for both direct and queued messages.
   */
  private async processMessage(message: any, channelId: string, channelName: string, prompt: string, imageUrls: string[] = []): Promise<void> {
    const sessionId = this.claudeManager.getSessionId(channelId);

    console.log(`Received message in channel: ${channelName} (${channelId})`);
    console.log(`Message content: ${prompt}`);
    console.log(`Existing session ID: ${sessionId || "none"}`);

    try {
      // Track the original message for reaction updates
      this.claudeManager.setOriginalMessage(channelId, message);

      // Check if we have an existing session
      const isNewSession = !sessionId;

      // Create status embed
      const statusEmbed = new EmbedBuilder()
        .setColor(0xFFD700); // Yellow for startup

      if (isNewSession) {
        statusEmbed
          .setTitle("🆕 Starting New Session")
          .setDescription("Initializing Claude Code...");
      } else {
        statusEmbed
          .setTitle("🔄 Continuing Session")
          .setDescription(`**Session ID:** ${sessionId}\nResuming Claude Code...`);
      }

      // Create initial Discord message
      const reply = await message.channel.send({ embeds: [statusEmbed] });
      console.log("Created Discord message:", reply.id);
      this.claudeManager.setDiscordMessage(channelId, reply);

      // Create Discord context for MCP server
      const discordContext = {
        channelId: channelId,
        channelName: channelName,
        userId: message.author.id,
        messageId: message.id,
      };

      // Reserve the channel and run Claude Code
      this.claudeManager.reserveChannel(channelId, sessionId, reply);
      await this.claudeManager.runClaudeCode(channelId, channelName, prompt, sessionId, discordContext, imageUrls);
    } catch (error) {
      console.error("Error running Claude Code:", error);

      // Clean up on error
      this.claudeManager.clearSession(channelId);

      const errorMessage = error instanceof Error ? error.message : String(error);
      try {
        await message.channel.send(`Error: ${errorMessage}`);
      } catch (sendError) {
        console.error("Failed to send error message:", sendError);
      }
    }
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }
}
