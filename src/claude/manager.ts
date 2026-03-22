import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder, AttachmentBuilder } from "discord.js";
import type { SDKMessage, CompletionStatus, PromptLinkConfig } from "../types/index.js";
import { getPromptLinkConfig } from "../types/index.js";
import { buildClaudeCommand, type DiscordContext } from "../utils/shell.js";
import { DatabaseManager } from "../db/database.js";
import type { SettingsStore } from "../settings/settings-store.js";

export type OnCompleteCallback = (channelId: string, status: CompletionStatus, originalMessage: any) => void;

export class ClaudeManager {
  private db: DatabaseManager;
  private channelMessages = new Map<string, any>();
  private channelToolCalls = new Map<string, Map<string, { message: any, toolId: string }>>();
  private channelNames = new Map<string, string>();
  private channelModels = new Map<string, string>();
  private channelProcesses = new Map<
    string,
    {
      process: any;
      sessionId?: string;
      discordMessage: any;
    }
  >();

  // Original user messages for reaction updates
  private originalMessages = new Map<string, any>();

  // Typing indicator intervals per channel
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  // Completion callback
  private onCompleteCallback?: OnCompleteCallback;

  // Guard: only fire completion once per run
  private completionNotified = new Set<string>();

  // Task threads: channelId -> Map<toolId, thread>
  private channelTaskThreads = new Map<string, Map<string, any>>();

  // Discord context per channel (for user mentions)
  private channelDiscordContexts = new Map<string, DiscordContext>();

  // Working directory overrides (for worktree threads)
  private workingDirOverrides = new Map<string, string>();

  // Plan mode per channel
  private channelPlanMode = new Map<string, boolean>();

  // Thread -> parent channel mapping (for plan mode inheritance)
  private parentChannelMap = new Map<string, string>();

  // Context usage tracking: channels that have already been warned
  private contextWarned = new Set<string>();

  private settings?: SettingsStore;
  private promptLinkConfig: PromptLinkConfig;

  constructor(private baseFolder: string, settings?: SettingsStore) {
    this.db = new DatabaseManager();
    this.settings = settings;
    this.promptLinkConfig = getPromptLinkConfig();
    // Clean up old sessions on startup
    this.db.cleanupOldSessions();

    // Load persisted settings
    if (settings) {
      const models = settings.getAllChannelModels();
      for (const [channelId, model] of Object.entries(models)) {
        this.channelModels.set(channelId, model);
      }
      const planModes = settings.getAllPlanModes();
      for (const [channelId, enabled] of Object.entries(planModes)) {
        this.channelPlanMode.set(channelId, enabled);
      }
    }
  }

  hasActiveProcess(channelId: string): boolean {
    return this.channelProcesses.has(channelId);
  }

  killActiveProcess(channelId: string): void {
    const activeProcess = this.channelProcesses.get(channelId);
    if (activeProcess?.process) {
      console.log(`Killing active process for channel ${channelId}`);
      this.stopTypingIndicator(channelId);
      activeProcess.process.kill("SIGTERM");
    }
  }

  killAllProcesses(): number {
    let count = 0;
    for (const [channelId, entry] of this.channelProcesses) {
      if (entry.process) {
        console.log(`Killing process for channel ${channelId}`);
        this.stopTypingIndicator(channelId);
        entry.process.kill("SIGTERM");
        count++;
      }
    }
    return count;
  }

  clearSession(channelId: string): void {
    this.killActiveProcess(channelId);
    this.stopTypingIndicator(channelId);
    this.db.clearSession(channelId);
    this.channelMessages.delete(channelId);
    this.channelToolCalls.delete(channelId);
    this.channelNames.delete(channelId);
    this.channelProcesses.delete(channelId);
    this.originalMessages.delete(channelId);
    this.channelDiscordContexts.delete(channelId);
    this.workingDirOverrides.delete(channelId);
    this.contextWarned.delete(channelId);
    this.cleanupTaskThreads(channelId);
  }

  setDiscordMessage(channelId: string, message: any): void {
    this.channelMessages.set(channelId, message);
    this.channelToolCalls.set(channelId, new Map());
  }

  setOriginalMessage(channelId: string, message: any): void {
    this.originalMessages.set(channelId, message);
  }

  getOriginalMessage(channelId: string): any {
    return this.originalMessages.get(channelId);
  }

  setWorkingDirOverride(channelId: string, workingDir: string): void {
    this.workingDirOverrides.set(channelId, workingDir);
  }

  setOnCompleteCallback(callback: OnCompleteCallback): void {
    this.onCompleteCallback = callback;
  }

  private notifyComplete(channelId: string, status: CompletionStatus): void {
    if (this.completionNotified.has(channelId)) return;
    this.completionNotified.add(channelId);

    this.stopTypingIndicator(channelId);

    const originalMessage = this.originalMessages.get(channelId);
    if (this.onCompleteCallback) {
      this.onCompleteCallback(channelId, status, originalMessage);
    }
  }

  // --- Typing indicator ---

  private startTypingIndicator(channelId: string): void {
    this.stopTypingIndicator(channelId); // clear any existing
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Send typing immediately, then every 8 seconds
    channel.sendTyping().catch(() => {});
    const interval = setInterval(() => {
      channel.sendTyping().catch(() => {});
    }, 8000);
    this.typingIntervals.set(channelId, interval);
  }

  private stopTypingIndicator(channelId: string): void {
    const interval = this.typingIntervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(channelId);
    }
  }

  // --- Task threads ---

  private async createTaskThread(channelId: string, toolId: string, description: string): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    try {
      // Create a short name from the description
      const threadName = description.length > 90
        ? description.substring(0, 87) + "..."
        : description;

      const thread = await channel.threads.create({
        name: `Task: ${threadName}`,
        autoArchiveDuration: 60,
      });

      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("📋 Task Started")
            .setDescription(description)
            .setColor(0x5865F2),
        ],
      });

      if (!this.channelTaskThreads.has(channelId)) {
        this.channelTaskThreads.set(channelId, new Map());
      }
      this.channelTaskThreads.get(channelId)!.set(toolId, thread);
    } catch (error) {
      console.error("Error creating task thread:", error);
    }
  }

  private async postTaskResult(channelId: string, toolId: string, result: string, isError: boolean): Promise<void> {
    const threads = this.channelTaskThreads.get(channelId);
    const thread = threads?.get(toolId);
    if (!thread) return;

    try {
      const truncated = result.length > 1900
        ? result.substring(0, 1900) + "..."
        : result;

      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(isError ? "❌ Task Failed" : "✅ Task Complete")
            .setDescription(truncated)
            .setColor(isError ? 0xFF0000 : 0x00FF00),
        ],
      });
    } catch (error) {
      console.error("Error posting task result:", error);
    }
  }

  private cleanupTaskThreads(channelId: string): void {
    const threads = this.channelTaskThreads.get(channelId);
    if (!threads) return;

    for (const [, thread] of threads) {
      thread.delete().catch(() => {});
    }
    this.channelTaskThreads.delete(channelId);
  }

  reserveChannel(
    channelId: string,
    sessionId: string | undefined,
    discordMessage: any
  ): void {
    // Kill any existing process (safety measure)
    const existingProcess = this.channelProcesses.get(channelId);
    if (existingProcess?.process) {
      console.log(
        `Killing existing process for channel ${channelId} before starting new one`
      );
      existingProcess.process.kill("SIGTERM");
    }

    // Reserve the channel by adding a placeholder entry (prevents race conditions)
    this.channelProcesses.set(channelId, {
      process: null, // Will be set when process actually starts
      sessionId,
      discordMessage,
    });

    // Reset completion guard for new run
    this.completionNotified.delete(channelId);
  }

  getSessionId(channelId: string): string | undefined {
    return this.db.getSession(channelId);
  }

  setModel(channelId: string, model: string): void {
    this.channelModels.set(channelId, model);
    this.settings?.setModel(channelId, model);
  }

  getModel(channelId: string): string {
    return this.channelModels.get(channelId) || "opus";
  }

  setPlanMode(channelId: string, enabled: boolean): void {
    this.channelPlanMode.set(channelId, enabled);
    this.settings?.setPlanMode(channelId, enabled);
  }

  isPlanMode(channelId: string): boolean {
    // Check if this channel has an explicit plan mode setting
    if (this.channelPlanMode.has(channelId)) {
      return this.channelPlanMode.get(channelId)!;
    }
    // Fall back to parent channel's plan mode (thread inheritance)
    const parentId = this.parentChannelMap.get(channelId);
    if (parentId) {
      return this.channelPlanMode.get(parentId) || false;
    }
    return false;
  }

  setParentChannel(threadId: string, parentId: string): void {
    this.parentChannelMap.set(threadId, parentId);
  }

  togglePlanMode(channelId: string): boolean {
    const current = this.isPlanMode(channelId);
    this.setPlanMode(channelId, !current);
    return !current;
  }

  private getWorkingDir(channelId: string): string | undefined {
    const override = this.workingDirOverrides.get(channelId);
    if (override) return override;
    const channelName = this.channelNames.get(channelId);
    if (channelName) return path.join(this.baseFolder, channelName);
    return undefined;
  }

  async runClaudeCode(
    channelId: string,
    channelName: string,
    prompt: string,
    sessionId?: string,
    discordContext?: DiscordContext,
    imageUrls?: string[]
  ): Promise<void> {
    // Store the channel name for path replacement
    this.channelNames.set(channelId, channelName);
    if (discordContext) {
      this.channelDiscordContexts.set(channelId, discordContext);
    }
    const workingDir = this.workingDirOverrides.get(channelId) || path.join(this.baseFolder, channelName);
    console.log(`Running Claude Code in: ${workingDir}`);

    // Check if working directory exists
    if (!fs.existsSync(workingDir)) {
      throw new Error(`Working directory does not exist: ${workingDir}`);
    }

    const model = this.getModel(channelId);
    const planMode = this.isPlanMode(channelId);
    const { command, args } = buildClaudeCommand(workingDir, prompt, sessionId, discordContext, model, imageUrls, planMode);
    console.log(`Running command: ${command} ${args.join(" ")}`);

    const claude = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workingDir,
      env: { ...process.env },
    });

    console.log(`Claude process spawned with PID: ${claude.pid}`);

    // Update the channel process tracking with actual process
    const channelProcess = this.channelProcesses.get(channelId);
    if (channelProcess) {
      channelProcess.process = claude;
    }

    // Start typing indicator
    this.startTypingIndicator(channelId);

    // Close stdin to signal we're not sending input
    claude.stdin.end();

    // Add immediate listeners to debug
    claude.on("spawn", () => {
      console.log("Process successfully spawned");
    });

    claude.on("error", (error) => {
      console.error("Process spawn error:", error);
    });

    let buffer = "";

    // Set a timeout for the Claude process (5 minutes)
    const timeout = setTimeout(() => {
      console.log("Claude process timed out, killing it");
      claude.kill("SIGTERM");

      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const timeoutEmbed = new EmbedBuilder()
          .setTitle("⏰ Timeout")
          .setDescription("Claude Code took too long to respond (5 minutes)")
          .setColor(0xFFD700); // Yellow for timeout

        channel.send({ embeds: [timeoutEmbed] }).catch(console.error);
      }
    }, 5 * 60 * 1000); // 5 minutes

    claude.stdout.on("data", (data) => {
      const rawData = data.toString();
      console.log("Raw stdout data:", rawData);

      // Log all streamed output to log.txt
      try {
        fs.appendFileSync(path.join(process.cwd(), 'log.txt'),
          `[${new Date().toISOString()}] Channel: ${channelId}\n${rawData}\n---\n`);
      } catch (error) {
        console.error("Error writing to log.txt:", error);
      }

      buffer += rawData;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          console.log("Processing line:", line);
          try {
            const parsed: SDKMessage = JSON.parse(line);
            console.log("Parsed message type:", parsed.type);

            if (parsed.type === "assistant" && parsed.message.content) {
              this.handleAssistantMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "user" && parsed.message.content) {
              this.handleToolResultMessage(channelId, parsed).catch(console.error);
            } else if (parsed.type === "result") {
              this.handleResultMessage(channelId, parsed).then(() => {
                clearTimeout(timeout);
                claude.kill("SIGTERM");
                this.channelProcesses.delete(channelId);
              }).catch(console.error);
            } else if (parsed.type === "system") {
              console.log("System message:", parsed.subtype);
              if (parsed.subtype === "init") {
                this.handleInitMessage(channelId, parsed).catch(console.error);
              }
              const channelName = this.channelNames.get(channelId) || "default";
              this.db.setSession(channelId, parsed.session_id, channelName);
            }
          } catch (error) {
            console.error("Error parsing JSON:", error, "Line:", line);
          }
        }
      }
    });

    claude.on("close", (code) => {
      console.log(`Claude process exited with code ${code}`);
      clearTimeout(timeout);
      this.stopTypingIndicator(channelId);
      // Ensure cleanup on process close
      this.channelProcesses.delete(channelId);

      // Notify completion (close event as fallback — result handler is primary)
      this.notifyComplete(channelId, "failed");

      if (code !== 0 && code !== null) {
        // Process failed - send error embed to Discord
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const errorEmbed = new EmbedBuilder()
            .setTitle("❌ Claude Code Failed")
            .setDescription(`Process exited with code: ${code}`)
            .setColor(0xFF0000); // Red for error

          channel.send({ embeds: [errorEmbed] }).catch(console.error);
        }
      }
    });

    claude.stderr.on("data", (data) => {
      const stderrOutput = data.toString();
      console.error("Claude stderr:", stderrOutput);

      // If there's significant stderr output, send warning to Discord
      if (
        stderrOutput.trim() &&
        !stderrOutput.includes("INFO") &&
        !stderrOutput.includes("DEBUG")
      ) {
        const channel = this.channelMessages.get(channelId)?.channel;
        if (channel) {
          const warningEmbed = new EmbedBuilder()
            .setTitle("⚠️ Warning")
            .setDescription(stderrOutput.trim())
            .setColor(0xFFA500); // Orange for warnings

          channel.send({ embeds: [warningEmbed] }).catch(console.error);
        }
      }
    });

    claude.on("error", (error) => {
      console.error("Claude process error:", error);
      clearTimeout(timeout);
      this.stopTypingIndicator(channelId);

      // Clean up process tracking on error
      this.channelProcesses.delete(channelId);

      // Notify completion on error
      this.notifyComplete(channelId, "failed");

      // Send error to Discord
      const channel = this.channelMessages.get(channelId)?.channel;
      if (channel) {
        const processErrorEmbed = new EmbedBuilder()
          .setTitle("❌ Process Error")
          .setDescription(error.message)
          .setColor(0xFF0000); // Red for errors

        channel.send({ embeds: [processErrorEmbed] }).catch(console.error);
      }
    });
  }

  private async handleInitMessage(channelId: string, parsed: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const initEmbed = new EmbedBuilder()
      .setTitle("🚀 Claude Code Session Started")
      .setDescription(`**Working Directory:** ${parsed.cwd}\n**Model:** ${parsed.model}\n**Tools:** ${parsed.tools.length} available`)
      .setColor(0x00FF00); // Green for init

    try {
      await channel.send({ embeds: [initEmbed] });
    } catch (error) {
      console.error("Error sending init message:", error);
    }
  }

  private async handleAssistantMessage(
    channelId: string,
    parsed: SDKMessage & { type: "assistant" }
  ): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const content = Array.isArray(parsed.message.content)
      ? parsed.message.content.find((c: any) => c.type === "text")?.text || ""
      : parsed.message.content;

    // Check for images in the message
    const images = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "image")
      : [];

    // Check for tool use in the message
    const toolUses = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    try {
      // If there's text content, send an assistant message
      if (content && content.trim()) {
        const assistantEmbed = new EmbedBuilder()
          .setTitle("💬 Claude")
          .setDescription(content)
          .setColor(this.isPlanMode(channelId) ? 0xE67E22 : 0x7289DA); // Orange for plan, blurple otherwise

        await channel.send({ embeds: [assistantEmbed] });

        // Detect and send any image file paths mentioned in the text
        await this.detectAndSendImagePaths(channelId, content);
      }

      // Send images if present
      for (const image of images) {
        await this.sendImageToDiscord(channelId, image);
      }

      // If there are tool uses, send a message for each tool
      for (const tool of toolUses) {
        // Detect Task tool — create a Discord thread for it
        if (tool.name === "Task") {
          const taskDescription = tool.input?.prompt || tool.input?.description || "Running task...";
          await this.createTaskThread(channelId, tool.id, taskDescription);
        }

        let toolMessage = `🔧 ${tool.name}`;

        if (tool.input && Object.keys(tool.input).length > 0) {
          const inputs = Object.entries(tool.input)
            .map(([key, value]) => {
              let val = String(value);
              // Replace base folder path with relative path
              const basePath = this.getWorkingDir(channelId);
              if (basePath) {
                if (val === basePath) {
                  val = ".";
                } else if (val.startsWith(basePath + path.sep)) {
                  val = val.replace(basePath + path.sep, "./");
                }
              }
              return `${key}=${val}`;
            })
            .join(", ");
          toolMessage += ` (${inputs})`;
        }

        const toolEmbed = new EmbedBuilder()
          .setDescription(`⏳ ${toolMessage}`)
          .setColor(this.isPlanMode(channelId) ? 0xE67E22 : 0x0099FF); // Orange for plan, blue otherwise

        const sentMessage = await channel.send({ embeds: [toolEmbed] });

        // Track this tool call message for later updating
        toolCalls.set(tool.id, {
          message: sentMessage,
          toolId: tool.id
        });
      }

      const channelName = this.channelNames.get(channelId) || "default";
      this.db.setSession(channelId, parsed.session_id, channelName);
      this.channelToolCalls.set(channelId, toolCalls);

      // Check context window usage and warn if getting full
      await this.checkContextUsage(channelId, parsed.message);
    } catch (error) {
      console.error("Error sending assistant message:", error);
    }
  }

  private static readonly CONTEXT_WINDOW_TOKENS = 200_000;
  private static readonly CONTEXT_WARNING_THRESHOLD = 0.80;

  private async checkContextUsage(channelId: string, message: any): Promise<void> {
    if (this.contextWarned.has(channelId)) return;

    const inputTokens = message?.usage?.input_tokens;
    if (!inputTokens) return;

    const pct = inputTokens / ClaudeManager.CONTEXT_WINDOW_TOKENS;
    if (pct < ClaudeManager.CONTEXT_WARNING_THRESHOLD) return;

    this.contextWarned.add(channelId);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const used = Math.round(inputTokens / 1000);
    const total = Math.round(ClaudeManager.CONTEXT_WINDOW_TOKENS / 1000);
    const pctDisplay = Math.round(pct * 100);

    const embed = new EmbedBuilder()
      .setTitle("⚠️ Context window filling up")
      .setDescription(
        `**${pctDisplay}%** used (${used}k / ${total}k tokens)\n\n` +
        `Run \`-claude /compact\` to free up space, or \`/clear\` to start fresh.`
      )
      .setColor(0xFFA500);

    try {
      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error("Failed to send context warning:", error);
    }
  }

  private async handleToolResultMessage(channelId: string, parsed: any): Promise<void> {
    const toolResults = Array.isArray(parsed.message.content)
      ? parsed.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    if (toolResults.length === 0) return;

    const toolCalls = this.channelToolCalls.get(channelId) || new Map();

    for (const result of toolResults) {
      // Post result to task thread if this was a Task tool
      const threads = this.channelTaskThreads.get(channelId);
      if (threads?.has(result.tool_use_id)) {
        await this.postTaskResult(channelId, result.tool_use_id, result.content, result.is_error === true);
      }

      // Tool result content can be a string or an array of content blocks
      const resultContent = result.content;
      let textContent = "";
      let imageBlocks: any[] = [];

      if (typeof resultContent === "string") {
        textContent = resultContent;
      } else if (Array.isArray(resultContent)) {
        // Extract text and image blocks from array content
        for (const block of resultContent) {
          if (block.type === "text") {
            textContent += (textContent ? "\n" : "") + block.text;
          } else if (block.type === "image") {
            imageBlocks.push(block);
          }
        }
      }

      const toolCall = toolCalls.get(result.tool_use_id);
      if (toolCall && toolCall.message) {
        try {
          // Get the first line of the result
          const firstLine = (textContent.split('\n')[0] || "").trim();
          const resultText = firstLine.length > 100
            ? firstLine.substring(0, 100) + "..."
            : firstLine;

          // Get the current embed and update it
          const currentEmbed = toolCall.message.embeds[0];
          const originalDescription = currentEmbed.data.description.replace("⏳", "✅");
          const isError = result.is_error === true;

          const updatedEmbed = new EmbedBuilder();

          if (isError) {
            updatedEmbed
              .setDescription(`❌ ${originalDescription.substring(2)}\n*${resultText}*`)
              .setColor(0xFF0000); // Red for errors
          } else {
            updatedEmbed
              .setDescription(`${originalDescription}\n*${resultText}*`)
              .setColor(0x00FF00); // Green for completed
          }

          await toolCall.message.edit({ embeds: [updatedEmbed] });
        } catch (error) {
          console.error("Error updating tool result message:", error);
        }
      }

      // Send any image content blocks from the tool result (e.g. screenshots)
      for (const image of imageBlocks) {
        await this.sendImageToDiscord(channelId, image);
      }

      // Detect and send any image file paths mentioned in the text result
      if (textContent) {
        await this.detectAndSendImagePaths(channelId, textContent);
      }
    }
  }

  private async handleResultMessage(
    channelId: string,
    parsed: SDKMessage & { type: "result" }
  ): Promise<void> {
    console.log("Result message:", parsed);
    const channelName = this.channelNames.get(channelId) || "default";
    this.db.setSession(channelId, parsed.session_id, channelName);

    this.stopTypingIndicator(channelId);

    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    // Build user mention
    const discordContext = this.channelDiscordContexts.get(channelId);
    const mention = discordContext ? `<@${discordContext.userId}>` : "";

    // Create a final result embed
    const resultEmbed = new EmbedBuilder();
    const success = parsed.subtype === "success";
    const planMode = this.isPlanMode(channelId);

    const EMBED_LIMIT = 4096;
    let fileAttachment: AttachmentBuilder | undefined;

    if (success) {
      let description = "result" in parsed ? parsed.result : "Task completed";
      const suffix = `\n\n*Completed in ${parsed.num_turns} turns*`;

      if (description.length + suffix.length > EMBED_LIMIT) {
        // Attach full response as a file and truncate embed description
        fileAttachment = new AttachmentBuilder(Buffer.from(description, "utf-8"), { name: "response.md" });
        description = description.slice(0, EMBED_LIMIT - suffix.length - 40) + "\n\n*(truncated — see attached file)*";
      }

      description += suffix;

      resultEmbed
        .setTitle(planMode ? "📋 Plan Complete" : "✅ Session Complete")
        .setDescription(description)
        .setColor(planMode ? 0x9B59B6 : 0x00FF00); // Purple for plan, green for success
    } else {
      resultEmbed
        .setTitle("❌ Session Failed")
        .setDescription(`Task failed: ${parsed.subtype}`)
        .setColor(0xFF0000); // Red for failure
    }

    // Notify completion early so the close handler doesn't race and mark it as failed
    this.notifyComplete(channelId, success ? "success" : "partial");

    // Add prompt link to result embed
    const originalMsg = this.originalMessages.get(channelId);
    if (this.promptLinkConfig.enabled && originalMsg) {
      const promptUrl = `https://discord.com/channels/${originalMsg.guildId}/${originalMsg.channelId}/${originalMsg.id}`;
      resultEmbed.addFields({ name: "Prompt", value: `[Jump to prompt](${promptUrl})` });
    }

    try {
      await channel.send({
        content: mention || undefined,
        embeds: [resultEmbed],
        files: fileAttachment ? [fileAttachment] : [],
      });
    } catch (error) {
      console.error("Error sending result message:", error);
    }

    console.log("Got result message, cleaning up process tracking");
  }

  /**
   * Send an image to Discord channel
   */
  private async sendImageToDiscord(channelId: string, imageContent: any): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    try {
      // Handle different image types
      if (imageContent.source?.type === "base64") {
        // Base64 encoded image
        const buffer = Buffer.from(imageContent.source.data, "base64");
        const ext = imageContent.source.media_type?.split("/")[1] || "png";
        const attachment = new AttachmentBuilder(buffer, { name: `image.${ext}` });

        await channel.send({
          content: "🖼️ **Image:**",
          files: [attachment]
        });
      } else if (imageContent.source?.type === "url") {
        // URL image
        await channel.send({
          content: "🖼️ **Image:**",
          embeds: [new EmbedBuilder().setImage(imageContent.source.url)]
        });
      }
    } catch (error) {
      console.error("Error sending image to Discord:", error);
    }
  }

  /**
   * Detect and send image file paths mentioned in text
   */
  private async detectAndSendImagePaths(channelId: string, text: string): Promise<void> {
    const channel = this.channelMessages.get(channelId)?.channel;
    if (!channel) return;

    const workingDir = this.getWorkingDir(channelId);
    if (!workingDir) return;

    // Common image extensions
    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];

    // Pattern to match file paths (both absolute and relative)
    const pathPattern = /(?:\.\/|\.\.\/|[A-Za-z]:[\\\/])?[\w\-\.\/\\]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi;
    const matches = text.match(pathPattern);

    if (!matches) return;

    const sentPaths = new Set<string>();

    for (const match of matches) {
      // Resolve to absolute path
      let imagePath = path.isAbsolute(match)
        ? match
        : path.join(workingDir, match);

      // Normalize path
      imagePath = path.normalize(imagePath);

      // Skip if already sent
      if (sentPaths.has(imagePath)) continue;

      // Check if file exists
      if (!fs.existsSync(imagePath)) continue;

      // Check if it's actually an image file
      const ext = path.extname(imagePath).toLowerCase();
      if (!imageExtensions.includes(ext)) continue;

      try {
        const attachment = new AttachmentBuilder(imagePath);
        await channel.send({
          content: `🖼️ **${path.basename(imagePath)}**`,
          files: [attachment]
        });
        sentPaths.add(imagePath);
      } catch (error) {
        console.error(`Error sending image ${imagePath}:`, error);
      }
    }
  }

  // Clean up resources
  destroy(): void {
    // Stop all typing indicators
    for (const [channelId] of this.typingIntervals) {
      this.stopTypingIndicator(channelId);
    }

    // Close all active processes
    for (const [channelId] of this.channelProcesses) {
      this.killActiveProcess(channelId);
    }

    // Close database connection
    this.db.close();
  }
}
