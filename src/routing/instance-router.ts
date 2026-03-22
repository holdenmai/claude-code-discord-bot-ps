import type { SettingsStore } from "../settings/settings-store.js";

export class InstanceRouter {
  constructor(
    private instanceId: string,
    private defaultPriority: number,
    private settings: SettingsStore,
  ) {}

  /**
   * Get the delay (ms) before this instance should process a message.
   * 0 = owned by us, Infinity = owned by other, N*5000 = unclaimed priority wait.
   */
  getDelay(channelId: string): number {
    const owner = this.settings.getTeleportOwner(channelId);
    if (owner === this.instanceId) return 0;
    if (owner) return Infinity;
    return (this.defaultPriority - 1) * 5000;
  }

  claimChannel(channelId: string): void {
    this.settings.setTeleportOwner(channelId, this.instanceId);
  }

  releaseChannel(channelId: string): void {
    this.settings.clearTeleportOwner(channelId);
  }

  ownsChannel(channelId: string): boolean {
    return this.settings.getTeleportOwner(channelId) === this.instanceId;
  }

  getOwner(channelId: string): string | undefined {
    return this.settings.getTeleportOwner(channelId);
  }

  get id(): string { return this.instanceId; }
  get priority(): number { return this.defaultPriority; }
}
