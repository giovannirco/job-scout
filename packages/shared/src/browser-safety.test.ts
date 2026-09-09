import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * apps/web imports the @job-scout/shared barrel, so every module the barrel
 * re-exports is evaluated in the browser by the Vite dev server. A named import
 * of a Node builtin, or a top-level `process` read, throws there and takes the
 * whole SPA down. `pnpm build` hides it: Rollup tree-shakes the unused export,
 * so only dev breaks — which is exactly when someone is trying to work on the UI.
 */
const dir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("shared is safe to evaluate in a browser", () => {
  it("has sources to check", () => expect(sources.length).toBeGreaterThan(5));

  it.each(sources)("%s uses no named import of a node: builtin", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    const named = src.match(/^import\s*\{[^}]*\}\s*from\s*"node:[^"]+";/gm) || [];
    expect(named, `use a namespace import so the property access happens at call time, not module init`).toEqual([]);
  });

  it.each(sources)("%s reads process defensively", (file) => {
    const src = readFileSync(join(dir, file), "utf8");
    const lines = src.split("\n");
    const guarded = src.includes('typeof process !== "undefined"');
    const topLevel = lines.filter(
      (l, i) =>
        /(?<![.\w])process\.env\b/.test(l) &&
        !/^\s*(\/\/|\*)/.test(l) &&
        // inside a function body the browser never calls it; only module scope is fatal
        !/^\s{2,}/.test(l) &&
        !guarded &&
        i >= 0,
    );
    expect(topLevel, "guard with `typeof process !== \"undefined\"` or move the read inside a function").toEqual([]);
  });
});
