import * as fs from "fs";
import * as path from "path";

interface SettingsData {
  models: Record<string, string>;
  allowedTools: Record<string, string[]>;
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
    return { models: {}, allowedTools: {} };
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
}
