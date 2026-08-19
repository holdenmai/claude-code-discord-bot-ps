import { describe, it, expect } from "vitest";
import { splitForDiscord, splitForDiscordCapped } from "../../src/utils/discord-text.js";

describe("splitForDiscord", () => {
  it("leaves a message that already fits alone", () => {
    expect(splitForDiscord("short", 100)).toEqual(["short"]);
  });

  it("breaks on line boundaries, never mid-line", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const parts = splitForDiscord(lines.join("\n"), 30);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(30);
    // Nothing lost and nothing reordered.
    expect(parts.join("\n").split("\n")).toEqual(lines);
  });

  it("hard-splits a single line that can't fit — better clipped than dropped", () => {
    const parts = splitForDiscord("x".repeat(250), 100);
    expect(parts).toHaveLength(3);
    expect(parts.join("")).toBe("x".repeat(250));
  });

  it("keeps the tail, which is where a per-item report puts its failures", () => {
    const body = ["ok 1", "ok 2", "ok 3", "FAILED 4"].join("\n");
    const parts = splitForDiscord(body, 12);
    expect(parts.at(-1)).toContain("FAILED 4");
  });
});

describe("splitForDiscordCapped", () => {
  it("passes through when the message fits inside the cap", () => {
    const parts = splitForDiscordCapped("a\nb\nc", 4, 10);
    expect(parts).toEqual(["a\nb\nc"]);
  });

  it("stops at the cap and says how much it dropped", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
    const parts = splitForDiscordCapped(body, 2, 30);

    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain("more message(s) of output not shown");
  });
});
