import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveAppVersion } from "./env.js";

const rootVersion = String((JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version);

describe("resolveAppVersion", () => {
  it("falls back to the root package.json version when APP_VERSION is unset", () => {
    expect(resolveAppVersion(undefined)).toBe(rootVersion);
  });

  it("falls back when APP_VERSION is empty or blank (the Dockerfile default)", () => {
    expect(resolveAppVersion("")).toBe(rootVersion);
    expect(resolveAppVersion("  ")).toBe(rootVersion);
  });

  it("uses APP_VERSION when set", () => {
    expect(resolveAppVersion("9.9.9-test")).toBe("9.9.9-test");
  });
});
