import type { DiscordContext, PendingApproval, PendingQuestionState } from './discord-context.js';
import type { PermissionDecision } from './permissions.js';
import { generateRequestId, formatToolForDiscord, requiresApproval } from './discord-context.js';
import { approveToolRequest } from './permissions.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import type { SettingsStore } from '../settings/settings-store.js';

export class PermissionManager {
  private pendingApprovals = new Map<string, PendingApproval>();
  private discordBot: any = null; // Will be set via setDiscordBot
  private claudeManager: any = null; // Will be set via setClaudeManager
  private approvalTimeout: number;
  private defaultOnTimeout: 'allow' | 'deny';
  // Questions get a longer window than plain approvals (they need real input).
  private questionTimeout = 120_000; // 2 minutes
  // Track tools that user chose "Always Allow" for, keyed by channelId
  private alwaysAllowedTools = new Map<string, Set<string>>();
  private settings?: SettingsStore;

  constructor(settings?: SettingsStore) {
    this.approvalTimeout = parseInt(process.env.MCP_APPROVAL_TIMEOUT || '30') * 1000; // Convert to ms
    this.defaultOnTimeout = (process.env.MCP_DEFAULT_ON_TIMEOUT as 'allow' | 'deny') || 'deny';
    this.settings = settings;

    // Load persisted always-allowed tools from settings
    if (settings) {
      const allTools = settings.getAllChannelAllowedTools();
      for (const [channelId, tools] of Object.entries(allTools)) {
        this.alwaysAllowedTools.set(channelId, new Set(tools));
      }
    }
  }

  /**
   * Set the Discord bot instance for sending approval messages
   */
  setDiscordBot(discordBot: any): void {
    this.discordBot = discordBot;
  }

  /**
   * Set the Claude manager, so answered questions can arm its post-answer
   * watchdog (the CLI sometimes accepts the answers and then wedges).
   */
  setClaudeManager(claudeManager: any): void {
    this.claudeManager = claudeManager;
  }

  /**
   * Whether a channel is currently blocked on the user, and on what — a question
   * it asked, or a tool approval. Used by the dashboard to distinguish "busy" from
   * "needs you", which is the distinction actually worth glancing at.
   *
   * A question outranks an approval when both are outstanding: it's the one that
   * needs a considered answer rather than a yes/no.
   *
   * This is in-memory only. Pending approvals don't survive a restart — but
   * neither does the CLI turn that raised them, so a channel reading as merely
   * active after a restart is accurate, not stale.
   */
  getWaitingKind(channelId: string): 'question' | 'approval' | undefined {
    let found: 'question' | 'approval' | undefined;
    for (const pending of this.pendingApprovals.values()) {
      if (pending.discordContext?.channelId !== channelId) continue;
      if (pending.pendingQuestion) return 'question';
      found = 'approval';
    }
    return found;
  }

  /**
   * Main entry point for permission requests from MCP server
   */
  async requestApproval(
    toolName: string, 
    input: any, 
    discordContext?: DiscordContext
  ): Promise<PermissionDecision> {
    console.log('PermissionManager: Processing approval request:', {
      toolName,
      input,
      discordContext,
      hasDiscordBot: !!this.discordBot
    });

    // Handle AskUserQuestion specially - needs interactive answer, not just allow/deny
    if (toolName === 'AskUserQuestion') {
      if (discordContext && this.discordBot) {
        console.log('PermissionManager: AskUserQuestion detected, showing question UI');
        return await this.requestQuestionAnswer(input, discordContext);
      } else {
        console.log('PermissionManager: AskUserQuestion but no Discord context/bot, denying');
        return {
          behavior: 'deny',
          message: 'Cannot display question to user - no Discord context available',
        };
      }
    }

    // If no Discord context, fall back to basic approval logic
    if (!discordContext) {
      console.log('PermissionManager: No Discord context, using basic approval');
      return await approveToolRequest(toolName, input, discordContext);
    }

    // If no Discord bot available, fall back to basic approval
    if (!this.discordBot) {
      console.log('PermissionManager: No Discord bot available, using basic approval');
      return await approveToolRequest(toolName, input, discordContext);
    }

    // Check if this tool requires approval
    if (!requiresApproval(toolName, input)) {
      console.log(`PermissionManager: Tool ${toolName} is safe, auto-approving`);
      return {
        behavior: 'allow',
        updatedInput: input,
      };
    }

    // Check if user previously chose "Always Allow" for this tool in this channel
    const channelAllowed = this.alwaysAllowedTools.get(discordContext.channelId);
    if (channelAllowed?.has(toolName)) {
      console.log(`PermissionManager: Tool ${toolName} auto-allowed (user chose "Always Allow")`);
      return {
        behavior: 'allow',
        updatedInput: input,
      };
    }

    // Tool requires interactive approval
    console.log(`PermissionManager: Tool ${toolName} requires approval, requesting Discord approval`);
    return await this.requestInteractiveApproval(toolName, input, discordContext);
  }

  /**
   * Request interactive approval via Discord message
   */
  private async requestInteractiveApproval(
    toolName: string,
    input: any,
    discordContext: DiscordContext
  ): Promise<PermissionDecision> {
    if (!this.discordBot) {
      console.error('PermissionManager: No Discord bot available, falling back to basic approval');
      return await approveToolRequest(toolName, input, discordContext);
    }

    const requestId = generateRequestId();
    
    return new Promise<PermissionDecision>((resolve, reject) => {
      // Create timeout handler
      const timeout = setTimeout(() => {
        this.handleApprovalTimeout(requestId);
      }, this.approvalTimeout);

      // Store pending approval
      const pending: PendingApproval = {
        requestId,
        toolName,
        input,
        discordContext,
        resolve,
        reject,
        timeout,
        createdAt: new Date(),
      };

      this.pendingApprovals.set(requestId, pending);

      // Send approval message to Discord
      this.sendApprovalMessage(pending).catch((error) => {
        console.error('PermissionManager: Failed to send approval message:', error);
        // Clean up and fall back to basic approval
        this.cleanupPendingApproval(requestId);
        approveToolRequest(toolName, input, discordContext).then(resolve).catch(reject);
      });
    });
  }

  /**
   * Send approval message to Discord with buttons
   */
  private async sendApprovalMessage(pending: PendingApproval): Promise<void> {
    try {
      // Get the Discord channel
      const channel = await this.discordBot.client.channels.fetch(pending.discordContext.channelId);
      if (!channel) {
        throw new Error(`Could not find Discord channel: ${pending.discordContext.channelId}`);
      }

      // Format the approval message as an embed
      const toolInfo = formatToolForDiscord(pending.toolName, pending.input);
      const embed = new EmbedBuilder()
        .setTitle('🔐 Permission Required')
        .setDescription(`${toolInfo}\n\n*Timeout in ${this.approvalTimeout / 1000}s (default: ${this.defaultOnTimeout})*`)
        .setColor(0xFFA500); // Orange

      // Create buttons
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve:${pending.requestId}`)
          .setLabel('Allow')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`deny:${pending.requestId}`)
          .setLabel('Deny')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌'),
        new ButtonBuilder()
          .setCustomId(`always:${pending.requestId}`)
          .setLabel('Always Allow')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🔓'),
      );

      // Send the message with buttons, mentioning the user
      const mention = `<@${pending.discordContext.userId}>`;
      const message = await (channel as any).send({ content: mention, embeds: [embed], components: [row] });

      // Store the message reference
      const pendingApproval = this.pendingApprovals.get(pending.requestId);
      if (pendingApproval) {
        pendingApproval.discordMessage = message;
      }

      console.log(`PermissionManager: Sent approval message for ${pending.requestId}`);
    } catch (error) {
      console.error('PermissionManager: Error sending approval message:', error);
      throw error;
    }
  }

  /**
   * Handle approval button click from Discord
   */
  handleApprovalInteraction(interaction: any): boolean {
    const customId: string = interaction.customId;

    let action: 'approve' | 'deny' | 'always' | null = null;
    let requestId: string | null = null;

    if (customId.startsWith('approve:')) {
      action = 'approve';
      requestId = customId.slice('approve:'.length);
    } else if (customId.startsWith('deny:')) {
      action = 'deny';
      requestId = customId.slice('deny:'.length);
    } else if (customId.startsWith('always:')) {
      action = 'always';
      requestId = customId.slice('always:'.length);
    }

    if (!action || !requestId) return false;

    const pendingApproval = this.pendingApprovals.get(requestId);
    if (!pendingApproval) {
      console.log('PermissionManager: No pending approval found for:', requestId);
      interaction.reply({ content: 'This approval has expired.', ephemeral: true }).catch(console.error);
      return true;
    }

    // Verify the user is authorized
    if (interaction.user.id !== pendingApproval.discordContext.userId) {
      interaction.reply({ content: 'Only the authorized user can approve.', ephemeral: true }).catch(console.error);
      return true;
    }

    // Clear timeout
    clearTimeout(pendingApproval.timeout);

    const approved = action === 'approve' || action === 'always';

    // If "Always Allow", add to auto-allowed set and persist
    if (action === 'always') {
      const channelId = pendingApproval.discordContext.channelId;
      if (!this.alwaysAllowedTools.has(channelId)) {
        this.alwaysAllowedTools.set(channelId, new Set());
      }
      this.alwaysAllowedTools.get(channelId)!.add(pendingApproval.toolName);
      this.settings?.addAllowedTool(channelId, pendingApproval.toolName);
      console.log(`PermissionManager: Tool ${pendingApproval.toolName} set to "Always Allow" for channel ${channelId}`);
    }

    // Create permission decision
    const decision: PermissionDecision = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput: approved ? pendingApproval.input : undefined,
      message: approved ? undefined : 'Denied by user',
    };

    const actionLabel = action === 'always' ? 'always allowed' : (approved ? 'approved' : 'denied');
    console.log(`PermissionManager: User ${actionLabel} tool ${pendingApproval.toolName}`);

    // Resolve the promise
    pendingApproval.resolve(decision);

    // Clean up
    this.cleanupPendingApproval(requestId);

    // Update the Discord message - delete it to keep chat clean
    interaction.update({
      embeds: [
        new EmbedBuilder()
          .setDescription(`${approved ? '✅' : '❌'} ${pendingApproval.toolName} — ${actionLabel}`)
          .setColor(approved ? 0x00FF00 : 0xFF0000),
      ],
      components: [],
    }).then(() => {
      setTimeout(() => {
        pendingApproval.discordMessage?.delete().catch(() => {});
      }, 3000);
    }).catch(console.error);

    return true;
  }

  /**
   * Handle approval reaction from Discord (legacy fallback)
   */
  handleApprovalReaction(channelId: string, messageId: string, userId: string, approved: boolean): void {
    console.log('PermissionManager: Handling approval reaction:', {
      channelId,
      messageId,
      userId,
      approved
    });

    // Find the pending approval by message ID and channel ID
    let pendingApproval: PendingApproval | undefined;
    let requestId: string | undefined;

    for (const [id, approval] of this.pendingApprovals.entries()) {
      if (approval.discordContext.channelId === channelId &&
          approval.discordMessage?.id === messageId) {
        pendingApproval = approval;
        requestId = id;
        break;
      }
    }

    if (!pendingApproval || !requestId) {
      console.log('PermissionManager: No pending approval found for message:', messageId);
      return;
    }

    // Verify the user is authorized to approve
    if (userId !== pendingApproval.discordContext.userId) {
      console.log('PermissionManager: Unauthorized user attempted approval:', userId);
      return;
    }

    // Clear timeout
    clearTimeout(pendingApproval.timeout);

    // Create permission decision
    const decision: PermissionDecision = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput: approved ? pendingApproval.input : undefined,
      message: approved ? undefined : 'Denied by user via Discord reaction',
    };

    console.log(`PermissionManager: User ${approved ? 'approved' : 'denied'} tool ${pendingApproval.toolName}`);

    // Resolve the promise
    pendingApproval.resolve(decision);

    // Clean up
    this.cleanupPendingApproval(requestId);

    // Update the Discord message to show the result
    this.updateApprovalMessage(pendingApproval.discordMessage, approved).catch(console.error);
  }

  /**
   * Handle approval timeout
   */
  private handleApprovalTimeout(requestId: string): void {
    const pendingApproval = this.pendingApprovals.get(requestId);
    if (!pendingApproval) {
      return;
    }

    console.log(`PermissionManager: Approval timed out for ${pendingApproval.toolName}, defaulting to ${this.defaultOnTimeout}`);

    const decision: PermissionDecision = {
      behavior: this.defaultOnTimeout,
      updatedInput: this.defaultOnTimeout === 'allow' ? pendingApproval.input : undefined,
      message: `Timed out after ${this.approvalTimeout / 1000} seconds, defaulted to ${this.defaultOnTimeout}`,
    };

    // Resolve the promise
    pendingApproval.resolve(decision);

    // Clean up
    this.cleanupPendingApproval(requestId);

    // Update the Discord message to show timeout
    this.updateApprovalMessage(pendingApproval.discordMessage, null).catch(console.error);
  }

  /**
   * Handle an AskUserQuestion timeout.
   *
   * Unlike a plain approval, a multi-question prompt is rendered one question at
   * a time in a single message that is edited forward. The generic timeout
   * handler would preserve only whichever question was on screen, losing the
   * already-answered and not-yet-shown ones. So we resolve the tool call the
   * same way (default deny / allow-with-partial-answers), then edit the message
   * to leave the FULL record of every question + option in chat for later
   * review, with the controls disabled.
   */
  private handleQuestionTimeout(requestId: string): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || !pending.pendingQuestion) return;

    console.log(`PermissionManager: Question timed out for ${requestId}, defaulting to ${this.defaultOnTimeout}`);

    const decision: PermissionDecision = {
      behavior: this.defaultOnTimeout,
      updatedInput: this.defaultOnTimeout === 'allow'
        ? { questions: pending.pendingQuestion.questions, answers: pending.pendingQuestion.answers }
        : undefined,
      message: `Question timed out after ${this.questionTimeout / 1000} seconds, defaulted to ${this.defaultOnTimeout}`,
    };

    pending.resolve(decision);
    this.cleanupPendingApproval(requestId);

    // Leave the FULL multi-question record in chat, controls disabled, so the
    // user can review every question and answer in a follow-up message.
    const summary = this.buildQuestionSummary(pending.pendingQuestion);
    pending.discordMessage?.edit({
      content: '',
      embeds: [
        new EmbedBuilder()
          .setTitle('⏰ Questions Timed Out — review below')
          .setDescription(summary.slice(0, 4096))
          .setColor(0xFFA500),
      ],
      components: [],
    }).catch(console.error);
  }

  /**
   * Update the approval message to show the result
   */
  private async updateApprovalMessage(message: any, approved: boolean | null): Promise<void> {
    if (!message) return;

    try {
      if (approved === true || approved === false) {
        // For user approvals/denials, delete the message to keep chat clean
        await message.delete();
        console.log(`PermissionManager: Deleted approval message after user ${approved ? 'approved' : 'denied'}`);
      } else {
        // For timeouts, leave the message in place (clearly marked) so it can be
        // reviewed later — the user didn't act, so deleting would destroy exactly
        // what they'd want to see. Disable the controls and preserve the embed.
        const statusEmoji = '⏰';
        const statusText = `**TIMED OUT** - defaulted to ${this.defaultOnTimeout.toUpperCase()}`;
        const baseContent = message.content?.trim() ? `${message.content}\n\n` : '';
        const updatedContent = `${baseContent}${statusEmoji} ${statusText}`;

        await message.edit({
          content: updatedContent,
          embeds: message.embeds ?? [], // preserve the question/approval detail
          components: [],               // disable stale buttons/select menus
        });

        // Remove reactions to prevent further interaction (legacy approval flow)
        await message.reactions?.removeAll?.().catch(() => {
          // Ignore errors if we can't remove reactions (permissions)
        });
      }
    } catch (error) {
      console.error('PermissionManager: Error updating approval message:', error);
    }
  }

  /**
   * Clean up a pending approval
   */
  private cleanupPendingApproval(requestId: string): void {
    const pendingApproval = this.pendingApprovals.get(requestId);
    if (pendingApproval) {
      clearTimeout(pendingApproval.timeout);
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Handle AskUserQuestion - show question with interactive buttons/menus
   */
  private async requestQuestionAnswer(
    input: any,
    discordContext: DiscordContext
  ): Promise<PermissionDecision> {
    const requestId = generateRequestId();
    const questions = input.questions || [];

    if (questions.length === 0) {
      return {
        behavior: 'deny',
        message: 'No questions provided',
      };
    }

    return new Promise<PermissionDecision>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleQuestionTimeout(requestId);
      }, this.questionTimeout);

      const pending: PendingApproval = {
        requestId,
        toolName: 'AskUserQuestion',
        input,
        discordContext,
        resolve,
        reject,
        timeout,
        createdAt: new Date(),
        pendingQuestion: {
          currentQuestionIndex: 0,
          answers: {},
          questions,
        },
      };

      this.pendingApprovals.set(requestId, pending);

      this.sendQuestionMessage(pending).catch((error) => {
        console.error('PermissionManager: Failed to send question message:', error);
        this.cleanupPendingApproval(requestId);
        resolve({
          behavior: 'deny',
          message: 'Failed to display question to user',
        });
      });
    });
  }

  /**
   * Build the embed + interactive components for the current question.
   * Discord allows at most 5 buttons per action row, so questions with more
   * than 5 options fall back to a select menu instead of buttons (otherwise
   * ActionRowBuilder.addComponents throws and the question never renders).
   */
  private buildQuestionView(pending: PendingApproval): { embeds: EmbedBuilder[]; components: any[] } {
    const questionState = pending.pendingQuestion!;
    const question = questionState.questions[questionState.currentQuestionIndex]!;
    const questionNumber = questionState.questions.length > 1
      ? ` (${questionState.currentQuestionIndex + 1}/${questionState.questions.length})`
      : '';

    const embed = new EmbedBuilder()
      .setTitle(`❓ ${question.header || 'Question'}${questionNumber}`)
      .setDescription(question.question)
      .setColor(0x5865F2) // Discord blurple
      .setFooter({ text: 'Select an option below' });

    // Add option descriptions to the embed
    const optionList = question.options
      .map((opt, i) => `**${String.fromCharCode(65 + i)}.** ${opt.label} — ${opt.description || ''}`)
      .join('\n');
    embed.addFields({ name: 'Options', value: optionList });

    const components: any[] = [];

    // Buttons only work for single-select questions with <= 5 options.
    const useSelectMenu = question.multiSelect || question.options.length > 5;

    if (useSelectMenu) {
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`qs:${pending.requestId}:${questionState.currentQuestionIndex}`)
        .setPlaceholder(question.multiSelect ? 'Select one or more options...' : 'Select an option...')
        .setMinValues(1)
        .setMaxValues(question.multiSelect ? question.options.length : 1)
        .addOptions(
          question.options.map((opt) => ({
            label: opt.label.substring(0, 100),
            description: (opt.description || '').substring(0, 100) || undefined,
            value: opt.label,
          }))
        );

      components.push(new ActionRowBuilder().addComponents(selectMenu));
    } else {
      // Use buttons for single-select questions
      const buttons = question.options.map((opt, i) =>
        new ButtonBuilder()
          .setCustomId(`q:${pending.requestId}:${questionState.currentQuestionIndex}:${i}`)
          .setLabel(`${String.fromCharCode(65 + i)}. ${opt.label}`.substring(0, 80))
          .setStyle(ButtonStyle.Primary)
      );

      components.push(new ActionRowBuilder().addComponents(...buttons));
    }

    return { embeds: [embed], components };
  }

  /**
   * Send a question message to Discord with buttons or select menu
   */
  private async sendQuestionMessage(pending: PendingApproval): Promise<void> {
    const channel = await this.discordBot.client.channels.fetch(pending.discordContext.channelId);
    if (!channel) {
      throw new Error(`Could not find Discord channel: ${pending.discordContext.channelId}`);
    }

    const questionState = pending.pendingQuestion!;
    const view = this.buildQuestionView(pending);

    if (pending.discordMessage) {
      // Update existing message for follow-up questions
      await pending.discordMessage.edit(view);
    } else {
      // Send new message for first question, mentioning the user
      const mention = `<@${pending.discordContext.userId}>`;
      const message = await (channel as any).send({ content: mention, ...view });
      pending.discordMessage = message;
    }

    console.log(`PermissionManager: Sent question ${questionState.currentQuestionIndex + 1}/${questionState.questions.length} for ${pending.requestId}`);
  }

  /**
   * Handle a button or select menu interaction for a question
   */
  handleQuestionInteraction(interaction: any): boolean {
    const customId: string = interaction.customId;

    // Parse button click: q:{requestId}:{questionIndex}:{optionIndex}
    if (customId.startsWith('q:') && !customId.startsWith('qs:')) {
      const parts = customId.split(':');
      if (parts.length !== 4) return false;

      const requestId = parts[1]!;
      const questionIndex = parseInt(parts[2]!);
      const optionIndex = parseInt(parts[3]!);

      const pending = this.pendingApprovals.get(requestId);
      if (!pending?.pendingQuestion) return false;

      // Verify user is authorized
      if (interaction.user.id !== pending.discordContext.userId) {
        interaction.reply({ content: 'Only the authorized user can answer.', ephemeral: true }).catch(console.error);
        return true;
      }

      const question = pending.pendingQuestion.questions[questionIndex];
      if (!question) return false;

      const selectedOption = question.options[optionIndex];
      if (!selectedOption) return false;

      // Record the answer
      pending.pendingQuestion.answers[question.question] = selectedOption.label;
      console.log(`PermissionManager: User answered "${question.question}" with "${selectedOption.label}"`);

      this.advanceOrResolveQuestion(pending, interaction);
      return true;
    }

    // Parse select menu: qs:{requestId}:{questionIndex}
    if (customId.startsWith('qs:')) {
      const parts = customId.split(':');
      if (parts.length !== 3) return false;

      const requestId = parts[1]!;
      const questionIndex = parseInt(parts[2]!);

      const pending = this.pendingApprovals.get(requestId);
      if (!pending?.pendingQuestion) return false;

      // Verify user is authorized
      if (interaction.user.id !== pending.discordContext.userId) {
        interaction.reply({ content: 'Only the authorized user can answer.', ephemeral: true }).catch(console.error);
        return true;
      }

      const question = pending.pendingQuestion.questions[questionIndex];
      if (!question) return false;

      // For select menus, values is an array of selected labels
      const selectedValues: string[] = interaction.values || [];
      pending.pendingQuestion.answers[question.question] = selectedValues.join(', ');
      console.log(`PermissionManager: User answered "${question.question}" with "${selectedValues.join(', ')}"`);

      this.advanceOrResolveQuestion(pending, interaction);
      return true;
    }

    return false;
  }

  /**
   * Rebuild a full record of every question + option from in-memory state.
   * Picked options are marked ✅, others ▫️; unanswered questions show
   * "(no answer)" and all their options remain visible. Shared by the
   * all-answered summary and the timeout record so a timed-out multi-question
   * prompt still shows every question (not just the one that was on screen).
   */
  private buildQuestionSummary(questionState: PendingQuestionState): string {
    return questionState.questions
      .map((q) => {
        const answer = questionState.answers[q.question] ?? '(no answer)';
        const picked = new Set(answer.split(', '));
        const title = q.header ? `**${q.header}** — ${q.question}` : `**${q.question}**`;
        const opts = q.options
          .map((o: any) => `${picked.has(o.label) ? '✅' : '▫️'} ${o.label}`)
          .join('\n');
        return `${title}\n${opts}\n→ **${answer}**`;
      })
      .join('\n\n');
  }

  /**
   * Plain-text rendering of the answers, for replaying them as a normal message
   * if the turn wedges after receiving them.
   */
  private buildAnswerReplay(questionState: PendingQuestionState): string {
    return questionState.questions
      .map((q) => `Q: ${q.question}\nA: ${questionState.answers[q.question] ?? '(no answer)'}`)
      .join('\n\n');
  }

  /**
   * Advance to the next question or resolve if all questions are answered
   */
  private advanceOrResolveQuestion(pending: PendingApproval, interaction: any): void {
    const questionState = pending.pendingQuestion!;
    const nextIndex = questionState.currentQuestionIndex + 1;

    if (nextIndex < questionState.questions.length) {
      // More questions to ask - advance and render the next one atomically in
      // the same interaction response. (A previous two-step "clear then edit"
      // could leave the message blank if the follow-up edit failed, making it
      // look like only the first question ever came through.)
      questionState.currentQuestionIndex = nextIndex;

      // Give the next question its own full window. The timeout is a budget per
      // question, not for the whole prompt: with one shared deadline, a careful
      // reader on a 3-question prompt could blow it mid-way, which resolved the
      // tool call as a denial and left every remaining button dead.
      clearTimeout(pending.timeout);
      pending.timeout = setTimeout(() => this.handleQuestionTimeout(pending.requestId), this.questionTimeout);

      interaction.update(this.buildQuestionView(pending)).catch((error: any) => {
        console.error('PermissionManager: Failed to render next question:', error);
      });
    } else {
      // All questions answered - resolve the promise
      clearTimeout(pending.timeout);

      const decision: PermissionDecision = {
        behavior: 'allow',
        updatedInput: {
          questions: questionState.questions,
          answers: questionState.answers,
        },
      };

      console.log('PermissionManager: All questions answered:', decision);
      pending.resolve(decision);

      // The answers are on their way back to the CLI over the MCP response. If
      // the turn goes silent from here, it's wedged — let the manager watch for
      // that and recover rather than losing the answers to the 10-minute reaper.
      try {
        this.claudeManager?.noteQuestionAnswered?.(
          pending.discordContext.channelId,
          this.buildAnswerReplay(questionState)
        );
      } catch (error) {
        console.error('PermissionManager: failed to arm question watchdog:', error);
      }

      // Leave the answered question(s) in place for later review — rebuild a full
      // record from the in-memory question data so the options aren't lost (the
      // selected one is marked). Disable the controls; do not delete.
      const summary = this.buildQuestionSummary(questionState);

      interaction.update({
        embeds: [
          new EmbedBuilder()
            .setTitle('✅ Questions Answered')
            .setDescription(summary.slice(0, 4096))
            .setColor(0x00FF00),
        ],
        components: [],
      }).catch(console.error);

      this.cleanupPendingApproval(pending.requestId);
    }
  }

  /**
   * Clean up all pending approvals (e.g., on shutdown)
   */
  cleanup(): void {
    console.log(`PermissionManager: Cleaning up ${this.pendingApprovals.size} pending approvals`);
    
    for (const [requestId, approval] of this.pendingApprovals.entries()) {
      clearTimeout(approval.timeout);
      approval.reject(new Error('Permission manager shutting down'));
    }
    
    this.pendingApprovals.clear();
  }

  /**
   * Clear "Always Allow" rules for a channel (e.g., on session clear)
   */
  clearAlwaysAllowed(channelId: string): void {
    this.alwaysAllowedTools.delete(channelId);
    this.settings?.clearAllowedTools(channelId);
    console.log(`PermissionManager: Cleared "Always Allow" rules for channel ${channelId}`);
  }

  /**
   * Get status information for debugging
   */
  getStatus(): {
    pendingCount: number;
    pendingRequests: Array<{
      requestId: string;
      toolName: string;
      channelId: string;
      createdAt: Date;
    }>;
  } {
    const pendingRequests = Array.from(this.pendingApprovals.entries()).map(([requestId, approval]) => ({
      requestId,
      toolName: approval.toolName,
      channelId: approval.discordContext.channelId,
      createdAt: approval.createdAt,
    }));

    return {
      pendingCount: this.pendingApprovals.size,
      pendingRequests,
    };
  }
}