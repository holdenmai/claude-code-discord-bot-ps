import * as fs from "fs";
import * as path from "path";

interface CustomCommand {
  name: string;
  prompt: string;
  promptWithMessage?: string;
}

interface SettingsData {
  models: Record<string, string>;
  allowedTools: Record<string, string[]>;
  planMode: Record<string, boolean>;
  homeCategory?: { guildId: string; categoryId: string };
  customCommands?: {
    global: CustomCommand[];
    perRepo: Record<string, CustomCommand[]>;
  };
  teleportOverrides?: Record<string, string>;
}

export class SettingsStore {
  private filePath: string;
  private data: SettingsData;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(process.cwd(), "settings.json");
    this.data = this.load();
  }

  private load(): SettingsData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw);
      }
    } catch (error) {
      console.error("SettingsStore: Error loading settings, using defaults:", error);
    }
    return { models: {}, allowedTools: {}, planMode: {} };
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error("SettingsStore: Error saving settings:", error);
    }
  }

  // --- Model settings ---

  getModel(channelId: string): string | undefined {
    return this.data.models[channelId];
  }

  setModel(channelId: string, model: string): void {
    this.data.models[channelId] = model;
    this.save();
  }

  getAllChannelModels(): Record<string, string> {
    return { ...this.data.models };
  }

  // --- Allowed tools settings ---

  getAllowedTools(channelId: string): string[] {
    return this.data.allowedTools[channelId] || [];
  }

  addAllowedTool(channelId: string, tool: string): void {
    if (!this.data.allowedTools[channelId]) {
      this.data.allowedTools[channelId] = [];
    }
    if (!this.data.allowedTools[channelId]!.includes(tool)) {
      this.data.allowedTools[channelId]!.push(tool);
      this.save();
    }
  }

  clearAllowedTools(channelId: string): void {
    delete this.data.allowedTools[channelId];
    this.save();
  }

  getAllChannelAllowedTools(): Record<string, string[]> {
    return { ...this.data.allowedTools };
  }

  // --- Plan mode settings ---

  getPlanMode(channelId: string): boolean {
    return this.data.planMode?.[channelId] || false;
  }

  setPlanMode(channelId: string, enabled: boolean): void {
    if (!this.data.planMode) this.data.planMode = {};
    this.data.planMode[channelId] = enabled;
    this.save();
  }

  getAllPlanModes(): Record<string, boolean> {
    return { ...(this.data.planMode || {}) };
  }

  // --- Home category settings ---

  getHomeCategory(): { guildId: string; categoryId: string } | undefined {
    return this.data.homeCategory;
  }

  setHomeCategory(guildId: string, categoryId: string): void {
    this.data.homeCategory = { guildId, categoryId };
    this.save();
  }

  // --- Teleport / instance routing ---

  getTeleportOwner(channelId: string): string | undefined {
    return this.data.teleportOverrides?.[channelId];
  }

  setTeleportOwner(channelId: string, instanceId: string): void {
    if (!this.data.teleportOverrides) this.data.teleportOverrides = {};
    this.data.teleportOverrides[channelId] = instanceId;
    this.save();
  }

  clearTeleportOwner(channelId: string): void {
    if (this.data.teleportOverrides) {
      delete this.data.teleportOverrides[channelId];
      this.save();
    }
  }

  // --- Custom commands ---

  private ensureCustomCommands() {
    if (!this.data.customCommands) {
      this.data.customCommands = { global: [], perRepo: {} };
    }
  }

  /**
   * Resolve a command name, checking repo-specific first, then global.
   * Returns the prompt string or undefined if not found.
   */
  resolveCustomCommand(name: string, repoName: string): CustomCommand | undefined {
    const cmds = this.data.customCommands;
    if (!cmds) return undefined;
    // Repo-specific takes priority
    const repoCmd = cmds.perRepo[repoName]?.find(c => c.name === name);
    if (repoCmd) return repoCmd;
    // Fall back to global
    return cmds.global.find(c => c.name === name);
  }

  addCustomCommand(name: string, prompt: string, repoName?: string, promptWithMessage?: string): void {
    this.ensureCustomCommands();
    const cmds = this.data.customCommands!;
    if (repoName) {
      if (!cmds.perRepo[repoName]) cmds.perRepo[repoName] = [];
      const list = cmds.perRepo[repoName]!;
      const entry: CustomCommand = { name, prompt, ...(promptWithMessage && { promptWithMessage }) };
      const idx = list.findIndex(c => c.name === name);
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
    } else {
      const entry: CustomCommand = { name, prompt, ...(promptWithMessage && { promptWithMessage }) };
      const idx = cmds.global.findIndex(c => c.name === name);
      if (idx >= 0) cmds.global[idx] = entry;
      else cmds.global.push(entry);
    }
    this.save();
  }

  removeCustomCommand(name: string, repoName?: string): boolean {
    const cmds = this.data.customCommands;
    if (!cmds) return false;
    if (repoName) {
      const list = cmds.perRepo[repoName];
      if (!list) return false;
      const idx = list.findIndex(c => c.name === name);
      if (idx < 0) return false;
      list.splice(idx, 1);
    } else {
      const idx = cmds.global.findIndex(c => c.name === name);
      if (idx < 0) return false;
      cmds.global.splice(idx, 1);
    }
    this.save();
    return true;
  }

  listCustomCommands(repoName: string): { global: CustomCommand[]; repo: CustomCommand[] } {
    const cmds = this.data.customCommands;
    return {
      global: cmds?.global || [],
      repo: cmds?.perRepo[repoName] || [],
    };
  }
}
