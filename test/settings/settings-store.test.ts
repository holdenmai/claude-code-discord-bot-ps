import { describe, it, expect, afterEach } from "vitest";
import { SettingsStore } from "../../src/settings/settings-store.js";
import * as fs from "fs";
import * as path from "path";

describe("SettingsStore", () => {
  const testPath = path.join(process.cwd(), "test-settings.json");

  afterEach(() => {
    try {
      fs.unlinkSync(testPath);
    } catch {}
  });

  describe("homeCategory", () => {
    it("should return undefined when no home category is set", () => {
      const store = new SettingsStore(testPath);
      expect(store.getHomeCategory()).toBeUndefined();
    });

    it("should save and retrieve home category", () => {
      const store = new SettingsStore(testPath);
      store.setHomeCategory("guild-1", "category-1");
      expect(store.getHomeCategory()).toEqual({
        guildId: "guild-1",
        categoryId: "category-1",
      });
    });

    it("should persist home category across instances", () => {
      const store1 = new SettingsStore(testPath);
      store1.setHomeCategory("guild-1", "category-1");

      const store2 = new SettingsStore(testPath);
      expect(store2.getHomeCategory()).toEqual({
        guildId: "guild-1",
        categoryId: "category-1",
      });
    });
  });
});
