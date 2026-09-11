import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const filePath = "packages/shared/src/hash.ts";

describe("real typed lint gate", () => {
  it("reports floating promises as errors while accepting explicit fire-and-forget", async () => {
    const eslint = new ESLint({ cwd: root });
    const [bad] = await eslint.lintText("Promise.resolve(1);\n", { filePath });
    expect(bad.messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "@typescript-eslint/no-floating-promises", severity: 2 })]));
    const [good] = await eslint.lintText("void Promise.resolve(1);\n", { filePath });
    expect(good.errorCount).toBe(0);
  });

  it("rejects named Node runtime imports in shared but allows namespace and type-only imports", async () => {
    const eslint = new ESLint({ cwd: root });
    const [bad] = await eslint.lintText('import { createHash } from "node:crypto";\n', { filePath });
    expect(bad.messages).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "no-restricted-syntax", severity: 2 })]));
    for (const source of ['import * as crypto from "node:crypto";\n', 'import type { Hash } from "node:crypto";\n', 'import { type Hash } from "node:crypto";\n']) {
      const [good] = await eslint.lintText(source, { filePath });
      expect(good.errorCount).toBe(0);
    }
  });

  it("CLI exits nonzero for a real violation", () => {
    const cli = spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--stdin", "--stdin-filename", filePath, "--format", "json"], { cwd: root, input: "Promise.resolve(1);\n", encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("@typescript-eslint/no-floating-promises");
  });
});
