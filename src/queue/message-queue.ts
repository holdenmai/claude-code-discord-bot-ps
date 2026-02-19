interface QueuedMessage {
  message: any;
  channelName: string;
  prompt: string;
}

export class MessageQueue {
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();

  /**
   * Enqueue a message for a channel. Returns true if the message was queued
   * (channel busy), false if the channel is free and the caller should process immediately.
   */
  async enqueue(channelId: string, message: any, channelName: string, prompt: string): Promise<boolean> {
    if (this.processing.has(channelId)) {
      // Channel is busy — queue the message and react with ⏳
      if (!this.queues.has(channelId)) {
        this.queues.set(channelId, []);
      }
      this.queues.get(channelId)!.push({ message, channelName, prompt });

      try {
        await message.react("⏳");
      } catch (error) {
        console.error("MessageQueue: Failed to react ⏳:", error);
      }

      return true; // was queued
    }

    // Channel is free — mark as processing
    this.processing.add(channelId);
    return false; // not queued, process now
  }

  /**
   * Called when the current processing for a channel is complete.
   * Returns the next queued message to process, or null if the queue is empty.
   */
  async dequeueNext(channelId: string): Promise<QueuedMessage | null> {
    const queue = this.queues.get(channelId);
    if (!queue || queue.length === 0) {
      // No more queued messages — release the channel
      this.processing.delete(channelId);
      this.queues.delete(channelId);
      return null;
    }

    const next = queue.shift()!;

    // Remove ⏳ reaction from the message we're about to process
    try {
      const botReactions = next.message.reactions?.cache?.get("⏳");
      if (botReactions) {
        await botReactions.users.remove(next.message.client?.user?.id).catch(() => {});
      }
    } catch (error) {
      console.error("MessageQueue: Failed to remove ⏳ reaction:", error);
    }

    return next;
  }

  /**
   * React with ✅ or ❌ on the original user message to indicate completion.
   */
  async markComplete(message: any, success: boolean): Promise<void> {
    if (!message) return;
    try {
      await message.react(success ? "✅" : "❌");
    } catch (error) {
      console.error("MessageQueue: Failed to react completion:", error);
    }
  }

  /**
   * Clear the queue for a channel (e.g., on /clear).
   * Removes ⏳ reactions from all queued messages.
   */
  async clearChannel(channelId: string): Promise<void> {
    const queue = this.queues.get(channelId);
    if (queue) {
      for (const item of queue) {
        try {
          const botReactions = item.message.reactions?.cache?.get("⏳");
          if (botReactions) {
            await botReactions.users.remove(item.message.client?.user?.id).catch(() => {});
          }
        } catch (error) {
          // Ignore cleanup errors
        }
      }
    }
    this.queues.delete(channelId);
    this.processing.delete(channelId);
  }

  /**
   * Check if a channel is currently processing.
   */
  isProcessing(channelId: string): boolean {
    return this.processing.has(channelId);
  }

  /**
   * Get the queue length for a channel.
   */
  getQueueLength(channelId: string): number {
    return this.queues.get(channelId)?.length || 0;
  }
}
