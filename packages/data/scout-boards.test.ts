import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("scout-boards registry", () => {
  it("parses and has unique provider+token pairs", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "scout-boards.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      boards: Array<{ company?: string; provider?: string; token?: string }>;
    };
    expect(Array.isArray(data.boards)).toBe(true);
    const keys = data.boards.map((b) => `${b.provider}:${String(b.token || "").toLowerCase()}`);
    expect(keys.every((k) => k.includes(":") && !k.endsWith(":"))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    expect(data.boards.every((b) => Boolean(b.company && b.provider && b.token))).toBe(true);
  });
});
