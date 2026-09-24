import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "../../..");
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
async function probe(name: string, envFile: boolean, override = false) {
  const dir = mkdtempSync(join(tmpdir(), "job-scout-env-"));
  if (envFile) writeFileSync(join(dir, ".env"), "AUTH_MODE=token\nAUTH_PASSWORD=synthetic-password-for-tests\nPUBLIC_BASE_URL=http://localhost:18981\n");
  const fixture = join(dir, "probe.mjs");
  writeFileSync(fixture, `console.log('ENV_PROBE:'+JSON.stringify({mode:process.env.AUTH_MODE,password:!!process.env.AUTH_PASSWORD,url:process.env.PUBLIC_BASE_URL}));`);
  const command = scripts[name].replace(/(?:apps|packages)\/\S+\.ts/, fixture);
  const child = spawn("/bin/sh", ["-c", command], { cwd: dir, detached: true,
    env: { PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`, HOME: process.env.HOME,
      ...(override ? { AUTH_MODE: "dev" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    return await new Promise<Record<string, unknown>>((res, rej) => {
      let output = "", errors = "";
      const timeout = setTimeout(() => rej(new Error(`No environment probe: ${errors}`)), 15_000);
      child.stderr.on("data", x => { errors += x; });
      child.stdout.on("data", x => { output += x; const match = output.match(/ENV_PROBE:(\{[^\n]+\})/); if (match) { clearTimeout(timeout); res(JSON.parse(match[1])); } });
      child.on("error", e => { clearTimeout(timeout); rej(e); });
      child.on("exit", code => { if (!output.includes("ENV_PROBE:")) { clearTimeout(timeout); rej(new Error(`Probe exited ${code}: ${errors}`)); } });
    });
  } finally {
    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already exited */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runtime command environment loading", () => {
  for (const command of ["dev", "dev:api", "dev:worker", "start", "start:worker", "once", "db:migrate", "db:repair"]) {
    it(`${command} loads .env before executing source`, async () => {
      expect(await probe(command, true)).toEqual({ mode: "token", password: true, url: "http://localhost:18981" });
    });
  }
  it("keeps exported credentials authoritative and allows a missing .env", async () => {
    expect((await probe("dev:api", true, true)).mode).toBe("dev");
    expect(await probe("dev:worker", false)).toEqual({ password: false });
  });
});
