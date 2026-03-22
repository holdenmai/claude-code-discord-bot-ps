import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { ClaudeManager } from '../claude/manager.js';
import { CommandHandler } from './commands.js';
import type { MCPPermissionServer } from '../mcp/server.js';
import { MessageQueue } from '../queue/message-queue.js';
import type { SettingsStore } from '../settings/settings-store.js';
import type { InstanceRouter } from '../routing/instance-router.js';
import { worktreeExists, getExistingWorktree, createWorktree, getWorktreePath, sanitizeWorktreeName } from '../utils/worktree.js';
import { isRawCommand } from '../utils/shell.js';
import { exec } from 'child_process';
import * as path from 'path';
import { getReactionConfig, getActivityLinkConfig, type ReactionConfig, type ActivityLinkConfig, type CompletionStatus } from '../types/index.js';

interface PendingWorktreeConfirmation {
  message: any;
  parentChannelName: string;
  threadName: string;
  branchName: string;
  sourceBranch: string;
  prompt: string;
  imageUrls: string[];
}

export class DiscordBot {
  public client: Client; // Make public so MCP server can access it
  private commandHandler: CommandHandler;
  private mcpServer?: MCPPermissionServer;
  private messageQueue: MessageQueue;
  private pendingWorktreeConfirmations = new Map<string, PendingWorktreeConfirmation>();
  private baseFolder: string;
  private reactionConfig: ReactionConfig;
  private activityLinkConfig: ActivityLinkConfig;

  constructor(
    private claudeManager: ClaudeManager,
    private allowedUserId: string,
    private settings?: SettingsStore,
    private instanceRouter?: InstanceRouter,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions, // Add reactions for approval
      ],
    });

    this.baseFolder = process.env.BASE_FOLDER || "";
    this.reactionConfig = getReactionConfig();
    this.activityLinkConfig = getActivityLinkConfig();
    this.commandHandler = new CommandHandler(claudeManager, allowedUserId, settings, instanceRouter);
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
    this.claudeManager.setOnCompleteCallback(async (channelId, status, originalMessage) => {
      // Swap reactions on the original user message
      if (this.reactionConfig.enabled && originalMessage) {
        try {
          // Remove processing reaction
          const processingReactions = originalMessage.reactions?.cache?.get(this.reactionConfig.processing);
          if (processingReactions) {
            await processingReactions.users.remove(originalMessage.client?.user?.id).catch(() => {});
          }
          // Add result reaction
          const emoji = this.reactionConfig[status];
          await originalMessage.react(emoji);
        } catch (error) {
          console.error("Failed to update reactions:", error);
        }
      }

      // Post activity link for completion
      if (originalMessage) {
        const isThread = originalMessage.channel?.isThread?.();
        const chName = isThread
          ? originalMessage.channel.parent?.name || "default"
          : originalMessage.channel?.name || "default";
        this.postActivityLink(originalMessage, "complete", chName).catch(err =>
          console.error("Failed to post complete activity link:", err)
        );
      }

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

      // Clean up threads in home category on startup
      await this.cleanupAllThreadsInHomeCategory();

      // Send startup announcement to allowed user
      try {
        const user = await this.client.users.fetch(this.allowedUserId);

        // Clean up old bot messages in DMs
        try {
          const dmChannel = await user.createDM();
          const messages = await dmChannel.messages.fetch({ limit: 100 });
          const botMessages = messages.filter(m => m.author.id === this.client.user!.id);
          for (const msg of botMessages.values()) {
            await msg.delete().catch(() => {});
          }
        } catch (error) {
          console.error("Failed to clean up DM messages:", error);
        }

        let startupMsg = `🚀 **Bot is online!**\nLogged in as ${this.client.user?.tag}`;
        if (this.instanceRouter) {
          startupMsg += `\nInstance: **${this.instanceRouter.id}** (priority ${this.instanceRouter.priority})`;
        }

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
              const links = categoryChannels.map(ch => `<#${ch.id}>`).join('\n');
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

        // Worktree confirmation buttons
        if (interaction.isButton()) {
          const customId = interaction.customId;
          if (customId.startsWith('wt-confirm:') || customId.startsWith('wt-cancel:')) {
            await this.handleWorktreeConfirmation(interaction);
            return;
          }
        }
      }

      // Handle /clear — also clear the queue and threads
      if (interaction.isCommand?.() && interaction.commandName === "clear") {
        await this.messageQueue.clearChannel(interaction.channelId);
        // Clean up threads in background (don't await to avoid slowing down response)
        this.cleanupThreads(interaction.channelId).then(count => {
          if (count > 0) {
            console.log(`Cleaned up ${count} thread(s) in channel ${interaction.channelId}`);
          }
        });
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

    // Ignore system messages (thread created, pin notifications, etc.)
    // MessageType.Default = 0, MessageType.Reply = 19
    if (message.type !== 0 && message.type !== 19) return;

    console.log("MESSAGE CREATED", message.id);

    if (message.author.id !== this.allowedUserId) {
      return;
    }

    const channelId = message.channelId;
    const isThread = message.channel?.isThread?.();

    // For threads: check if this is a reply to a worktree confirmation prompt
    if (isThread) {
      const pending = this.pendingWorktreeConfirmations.get(channelId);
      if (pending) {
        // User replied with a custom branch name
        pending.branchName = message.content.trim();
        await this.executeWorktreeCreation(channelId, pending);
        return;
      }
    }

    let channelName: string;
    let threadName: string | undefined;

    if (isThread) {
      // Thread: parent channel = repo, thread name = worktree
      const parentChannel = message.channel.parent;
      channelName = parentChannel?.name || "default";
      threadName = message.channel.name;
      // Register parent mapping so threads inherit plan mode
      if (parentChannel?.id) {
        this.claudeManager.setParentChannel(channelId, parentChannel.id);
      }
    } else {
      channelName = message.channel && "name" in message.channel
        ? message.channel.name
        : "default";
    }

    // Don't run in general channel
    if (channelName === "general") {
      return;
    }

    // Multi-instance routing
    if (this.instanceRouter) {
      // Use parent channel for thread routing
      const routingId = isThread ? (message.channel.parent?.id || channelId) : channelId;

      // !teleport @Bot — both instances process this
      if (message.content.startsWith("!teleport")) {
        const mentioned = message.mentions.users?.first();
        if (!mentioned) {
          // Status query — only the owning or default instance replies
          const owner = this.instanceRouter.getOwner(routingId);
          const delay = this.instanceRouter.getDelay(routingId);
          if (delay === 0 || (delay !== Infinity && !owner)) {
            const status = owner
              ? `📡 Channel owned by **${owner}**`
              : `📡 Channel unclaimed (priority routing active)`;
            await message.reply(status);
          }
        } else if (mentioned.id === this.client.user?.id) {
          // Teleporting TO this bot
          this.instanceRouter.claimChannel(routingId);
          await message.reply(`📡 Teleported to **${this.instanceRouter.id}**`);
        } else {
          // Teleporting to another bot — release and kill
          this.instanceRouter.releaseChannel(routingId);
          this.claudeManager.killActiveProcess(channelId);
        }
        return;
      }

      // !abandon — clear ownership, all bots process this
      if (message.content === "!abandon") {
        const wasOwner = this.instanceRouter.ownsChannel(routingId);
        this.instanceRouter.releaseChannel(routingId);
        this.claudeManager.killActiveProcess(channelId);
        if (wasOwner) {
          await message.reply("🔓 Channel released — next message uses priority routing");
        }
        return;
      }

      // Priority-based routing for regular messages
      const delay = this.instanceRouter.getDelay(routingId);
      if (delay === Infinity) return; // owned by another instance
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
        // Check if a higher-priority bot already reacted (processing reaction)
        try {
          const refreshed = await message.fetch();
          const processingReaction = refreshed.reactions.cache.get(this.reactionConfig.processing);
          if (processingReaction && processingReaction.count > 0) {
            return; // another bot is handling it
          }
        } catch {
          // If fetch fails, proceed anyway
        }
      }
      // We're processing — claim the channel (sticky)
      this.instanceRouter.claimChannel(routingId);
    }

    // Post activity link for user prompt (fire and forget)
    this.postActivityLink(message, "prompt", channelName).catch(err =>
      console.error("Failed to post prompt activity link:", err)
    );

    // Custom command shorthand: messages starting with !
    if (message.content.startsWith("!") && this.settings) {
      const rest = message.content.slice(1);
      const spaceIdx = rest.indexOf(" ");
      const cmdName = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
      const extra = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : "";

      const cmd = this.settings.resolveCustomCommand(cmdName, channelName);
      if (cmd) {
        let prompt: string;
        if (extra) {
          const tpl = cmd.promptWithMessage || cmd.prompt;
          if (tpl.includes("{message}")) {
            prompt = tpl.replace("{message}", extra);
          } else {
            prompt = `${tpl} ${extra}`;
          }
        } else {
          prompt = cmd.prompt.replace(" {message}", "").replace("{message}", "");
        }

        // Fall through to normal message processing with resolved prompt
        const imageAttachments = Array.from(message.attachments?.values() || [])
          .filter((att: any) => att.contentType?.startsWith("image/"))
          .map((att: any) => att.url);

        if (threadName) {
          const existing = getExistingWorktree(this.baseFolder, channelName, threadName);
          if (existing) {
            this.claudeManager.setWorkingDirOverride(channelId, existing.path);
          }
        }

        const wasQueued = await this.messageQueue.enqueue(channelId, message, channelName, prompt, imageAttachments);
        if (!wasQueued) {
          await this.processMessage(message, channelId, channelName, prompt, imageAttachments);
        }
        return;
      }
      // If no matching command, fall through to normal processing
    }

    // Shell command: messages starting with - (but not --) run directly in the shell
    if (message.content.startsWith("-") && !message.content.startsWith("--")) {
      let shellCmd = message.content.slice(1).trim();
      if (shellCmd) {
        let workingDir: string;
        if (threadName) {
          const existing = getExistingWorktree(this.baseFolder, channelName, threadName);
          workingDir = existing?.path || path.join(this.baseFolder, channelName);
        } else {
          workingDir = path.join(this.baseFolder, channelName);
        }
        // Auto-inject --resume for claude commands so they target the current session
        if (shellCmd.startsWith("claude ")) {
          const sessionId = this.claudeManager.getSessionId(channelId);
          if (sessionId) {
            shellCmd = shellCmd.replace("claude ", `claude --resume ${sessionId} `);
          }
        }
        await this.runShellCommand(message, shellCmd, workingDir);
        return;
      }
    }

    // Extract image attachments if any
    const imageAttachments = Array.from(message.attachments?.values() || [])
      .filter((att: any) => att.contentType?.startsWith("image/"))
      .map((att: any) => att.url);

    if (imageAttachments.length > 0) {
      console.log(`Found ${imageAttachments.length} image(s):`, imageAttachments);
    }

    // If this is a thread, handle worktree setup
    if (threadName) {
      const existing = getExistingWorktree(this.baseFolder, channelName, threadName);
      if (!existing) {
        // Need to create worktree — prompt for confirmation
        await this.promptWorktreeConfirmation(message, channelName, threadName, message.content, imageAttachments);
        return;
      }
      // Worktree exists — set the working directory override and continue
      this.claudeManager.setWorkingDirOverride(channelId, existing.path);
    }

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

      // Add processing reaction
      if (this.reactionConfig.enabled) {
        try { await message.react(this.reactionConfig.processing); } catch {}
      }

      // Check if we have an existing session
      const isNewSession = !sessionId;
      const planMode = this.claudeManager.isPlanMode(channelId);
      const planTag = planMode ? " 📋" : "";

      // Create status embed
      const statusEmbed = new EmbedBuilder()
        .setColor(planMode ? 0xE67E22 : 0xFFD700); // Orange for plan mode, yellow otherwise

      if (isRawCommand(prompt)) {
        statusEmbed
          .setTitle("⚡ Running Command")
          .setDescription(`\`${prompt}\``);
      } else if (isNewSession) {
        statusEmbed
          .setTitle(`🆕 Starting New Session${planTag}`)
          .setDescription(planMode ? "Initializing Claude Code in **plan mode**..." : "Initializing Claude Code...");
      } else {
        statusEmbed
          .setTitle(`🔄 Continuing Session${planTag}`)
          .setDescription(`**Session ID:** ${sessionId}\n${planMode ? "Resuming in **plan mode**..." : "Resuming Claude Code..."}`);
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

  /**
   * Run a shell command in the given working directory and post output to Discord.
   */
  private async runShellCommand(message: any, command: string, cwd: string): Promise<void> {
    const statusEmbed = new EmbedBuilder()
      .setTitle("⚡ Running Shell Command")
      .setDescription(`\`${command}\``)
      .setColor(0xFFD700);

    const reply = await message.channel.send({ embeds: [statusEmbed] });

    exec(command, { cwd, timeout: 120_000 }, async (error, stdout, stderr) => {
      const output = (stdout || "") + (stderr || "");
      const truncated = output.length > 1900
        ? output.slice(0, 1900) + "\n...(truncated)"
        : output;

      const resultEmbed = new EmbedBuilder()
        .setTitle(error ? "❌ Command Failed" : "✅ Command Complete")
        .setColor(error ? 0xFF0000 : 0x00FF00);

      if (truncated.trim()) {
        resultEmbed.setDescription(`\`\`\`\n${truncated}\n\`\`\``);
      } else {
        resultEmbed.setDescription("*(no output)*");
      }

      try {
        await reply.edit({ embeds: [resultEmbed] });
      } catch (e) {
        console.error("Failed to update shell command result:", e);
      }
    });
  }

  /**
   * Prompt user to confirm worktree creation with branch name override option.
   */
  private async promptWorktreeConfirmation(
    message: any,
    parentChannelName: string,
    threadName: string,
    prompt: string,
    imageUrls: string[]
  ): Promise<void> {
    const branchName = sanitizeWorktreeName(threadName);
    const sourceBranch = "main";
    const channelId = message.channelId;

    this.pendingWorktreeConfirmations.set(channelId, {
      message,
      parentChannelName,
      threadName,
      branchName,
      sourceBranch,
      prompt,
      imageUrls,
    });

    const wtPath = getWorktreePath(this.baseFolder, parentChannelName, threadName);
    const embed = new EmbedBuilder()
      .setTitle("🌿 Create Worktree?")
      .setDescription(
        `**Worktree:** \`${threadName}\`\n` +
        `**Branch:** \`${branchName}\`\n` +
        `**From:** \`${sourceBranch}\`\n` +
        `**Path:** \`${wtPath}\`\n\n` +
        `Reply with a different branch name to override, or click Confirm.`
      )
      .setColor(0xFFD700);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`wt-confirm:${channelId}`)
        .setLabel("Confirm")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`wt-cancel:${channelId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger),
    );

    await message.channel.send({ embeds: [embed], components: [row] });
  }

  /**
   * Handle worktree confirmation button clicks.
   */
  private async handleWorktreeConfirmation(interaction: any): Promise<void> {
    const customId = interaction.customId as string;
    const channelId = customId.split(":")[1];
    const pending = this.pendingWorktreeConfirmations.get(channelId);

    if (!pending) {
      await interaction.reply({ content: "No pending worktree confirmation.", ephemeral: true });
      return;
    }

    if (customId.startsWith("wt-cancel:")) {
      this.pendingWorktreeConfirmations.delete(channelId);
      await interaction.update({
        embeds: [new EmbedBuilder().setTitle("❌ Worktree creation cancelled").setColor(0xFF0000)],
        components: [],
      });
      return;
    }

    // wt-confirm
    await interaction.update({
      embeds: [new EmbedBuilder().setTitle("⏳ Creating worktree...").setColor(0xFFD700)],
      components: [],
    });

    await this.executeWorktreeCreation(channelId, pending);
  }

  /**
   * Execute worktree creation and then process the original message.
   */
  private async executeWorktreeCreation(channelId: string, pending: PendingWorktreeConfirmation): Promise<void> {
    this.pendingWorktreeConfirmations.delete(channelId);

    try {
      const wtInfo = createWorktree(
        this.baseFolder,
        pending.parentChannelName,
        pending.threadName,
        pending.branchName,
        pending.sourceBranch
      );

      await pending.message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Worktree Created")
            .setDescription(`**Branch:** \`${wtInfo.branch}\`\n**Path:** \`${wtInfo.path}\``)
            .setColor(0x00FF00),
        ],
      });

      // Set working directory override and process the message
      this.claudeManager.setWorkingDirOverride(channelId, wtInfo.path);

      const wasQueued = await this.messageQueue.enqueue(
        channelId, pending.message, pending.parentChannelName, pending.prompt, pending.imageUrls
      );
      if (!wasQueued) {
        await this.processMessage(
          pending.message, channelId, pending.parentChannelName, pending.prompt, pending.imageUrls
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await pending.message.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Worktree Creation Failed")
            .setDescription(errorMsg)
            .setColor(0xFF0000),
        ],
      });
    }
  }

  /**
   * Post an activity link to the "general" channel in the home category,
   * and to the parent channel if the source message is in a thread.
   */
  private async postActivityLink(
    message: any,
    event: "prompt" | "complete",
    channelName: string,
  ): Promise<void> {
    if (!this.activityLinkConfig.enabled) return;

    const home = this.settings?.getHomeCategory();
    if (!home) return;

    const messageUrl = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
    const isThread = message.channel?.isThread?.();

    // Build the content based on style
    const content = this.formatActivityLink(event, channelName, messageUrl, isThread ? message.channel.name : undefined);
    if (!content) return;

    const targets: string[] = [];

    // Find "general" channel in home category
    try {
      const guild = await this.client.guilds.fetch(home.guildId);
      const channels = await guild.channels.fetch();
      const generalChannel = channels.find(
        (ch): ch is NonNullable<typeof ch> =>
          ch !== null && ch.parentId === home.categoryId && ch.name === "general"
      );
      if (generalChannel) {
        targets.push(generalChannel.id);
      }
    } catch (error) {
      console.error("Failed to find general channel:", error);
    }

    // If in a thread, also post to the parent channel
    if (isThread && message.channel.parentId) {
      const parentId = message.channel.parentId;
      // Don't double-post if parent IS general
      if (!targets.includes(parentId)) {
        targets.push(parentId);
      }
    }

    // Post to all targets
    for (const targetId of targets) {
      try {
        const channel = await this.client.channels.fetch(targetId);
        if (channel && 'send' in channel) {
          if (this.activityLinkConfig.style === "embed") {
            const embed = new EmbedBuilder()
              .setDescription(content)
              .setColor(event === "prompt" ? 0x5865F2 : 0x57F287)
              .setTimestamp();
            await (channel as any).send({ embeds: [embed] });
          } else {
            await (channel as any).send(content);
          }
        }
      } catch (error) {
        console.error(`Failed to post activity link to ${targetId}:`, error);
      }
    }
  }

  /**
   * Format an activity link message based on the configured style.
   */
  private formatActivityLink(
    event: "prompt" | "complete",
    channelName: string,
    messageUrl: string,
    threadName?: string,
  ): string | null {
    const icon = event === "prompt" ? "📨" : "✅";
    const action = event === "prompt" ? "Prompt" : "Complete";
    const location = threadName ? `#${channelName}/${threadName}` : `#${channelName}`;

    switch (this.activityLinkConfig.style) {
      case "link":
        return messageUrl;
      case "embed":
      case "plaintext":
      default:
        return `${icon} **${action}** in ${location} — [Jump](${messageUrl})`;
    }
  }

  /**
   * Clean up all threads in a channel (delete bot-created threads)
   */
  async cleanupThreads(channelId: string): Promise<number> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('threads' in channel)) return 0;

      const threads = await (channel as any).threads.fetchActive();
      let deleted = 0;

      for (const thread of threads.threads.values()) {
        // Only delete Task threads created by the bot (skip worktree threads)
        if (thread.ownerId === this.client.user?.id && thread.name.startsWith("Task: ")) {
          try {
            await thread.delete();
            deleted++;
          } catch (error) {
            console.error(`Failed to delete thread ${thread.id}:`, error);
          }
        }
      }

      // Also fetch archived threads
      try {
        const archivedThreads = await (channel as any).threads.fetchArchived();
        for (const thread of archivedThreads.threads.values()) {
          if (thread.ownerId === this.client.user?.id && thread.name.startsWith("Task: ")) {
            try {
              await thread.delete();
              deleted++;
            } catch (error) {
              console.error(`Failed to delete archived thread ${thread.id}:`, error);
            }
          }
        }
      } catch (error) {
        // Archived threads fetch might fail, ignore
      }

      return deleted;
    } catch (error) {
      console.error(`Failed to cleanup threads in channel ${channelId}:`, error);
      return 0;
    }
  }

  /**
   * Clean up threads in all channels in the home category
   */
  async cleanupAllThreadsInHomeCategory(): Promise<void> {
    const home = this.settings?.getHomeCategory();
    if (!home) return;

    try {
      const guild = await this.client.guilds.fetch(home.guildId);
      const channels = await guild.channels.fetch();
      const categoryChannels = channels.filter(
        (ch): ch is NonNullable<typeof ch> =>
          ch !== null && ch.parentId === home.categoryId && ch.isTextBased() && !ch.isThread()
      );

      let totalDeleted = 0;
      for (const channel of categoryChannels.values()) {
        const deleted = await this.cleanupThreads(channel.id);
        if (deleted > 0) {
          console.log(`Cleaned up ${deleted} thread(s) in #${channel.name}`);
          totalDeleted += deleted;
        }
      }

      if (totalDeleted > 0) {
        console.log(`Total threads cleaned up on startup: ${totalDeleted}`);
      }
    } catch (error) {
      console.error("Failed to cleanup threads in home category:", error);
    }
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }
}
