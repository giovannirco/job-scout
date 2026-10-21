import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { apiTokens, closeDb, getDb, positions } from "@job-scout/db";
import { bootstrap, upsertFromJob } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-contract-"));
const original = { ...env };
const credential = "js_test_contract_credential_value_for_mcp_tests";
let rpcId = 0;

type ToolResult = { raw: string; bytes: number; isError: boolean; data: any };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await handleMcpHttp(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(res.status).toBe(200);
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  const body = JSON.parse(json) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
  expect(body.error).toBeUndefined();
  const text = body.result?.content?.[0]?.text || "null";
  return { raw: text, bytes: Buffer.byteLength(text), isError: Boolean(body.result?.isError), data: JSON.parse(text) };
}

let seq = 0;
async function position(over: { title?: string; url?: string; board?: string; descriptionText?: string } = {}) {
  const n = ++seq;
  const board = over.board || `example-board-${n}`;
  const { position } = await upsertFromJob({
    provider: "greenhouse", boardToken: board, jobId: String(1000 + n), company: `Example Co ${n}`,
    title: over.title || "Platform Engineer", url: over.url || `https://boards.greenhouse.io/${board}/jobs/${1000 + n}`, locationRaw: "Remote",
    descriptionText: over.descriptionText || "Operate Kubernetes for an example product. " + "y".repeat(400), listingStatus: "open",
  }, { status: "review" });
  return position;
}

describe("MCP contract", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    const db = await getDb();
    await db.insert(apiTokens).values({ id: "token_contract", name: "contract-agent", scopes: ["mcp"], tokenPrefix: credential.slice(0, 8), tokenHash: await bcrypt.hash(credential, 4) });
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  describe("write echoes", () => {
    it("update_position and set_position_status return a compact summary unless verbose", async () => {
      const p = await position();
      const db = await getDb();
      await db.update(positions).set({ triageJson: { oneLiner: "fits", reasons: Array.from({ length: 200 }, (_, i) => `reason ${i} `.repeat(20)) } }).where(eq(positions.id, p.id));
      const upd = await call("update_position", { idOrSlug: p.id, notes: "follow up next week", priority: "P1" });
      expect(upd.isError).toBe(false);
      expect(upd.data).toMatchObject({ id: p.id, slug: p.slug, status: "review", notes: "follow up next week", priority: "P1" });
      expect(upd.data.updatedAt).toBeTruthy();
      expect(upd.data).not.toHaveProperty("triageJson");
      expect(upd.data).not.toHaveProperty("metadata");
      expect(upd.bytes).toBeLessThan(3_000);

      const st = await call("set_position_status", { idOrSlug: p.id, status: "applied" });
      expect(st.data).toMatchObject({ id: p.id, status: "applied" });
      expect(st.data.appliedAt).toBeTruthy();
      expect(st.data).not.toHaveProperty("triageJson");

      const full = await call("set_position_status", { idOrSlug: p.id, status: "screen", verbose: true });
      expect(full.data).toMatchObject({ id: p.id, status: "screen" });
      expect(full.data.triageJson.oneLiner).toBe("fits");
    });

    it("not found stays an error", async () => {
      const r = await call("update_position", { idOrSlug: "pos_missing", notes: "x" });
      expect(r).toMatchObject({ isError: true, data: { error: "not found" } });
    });
  });

  describe("upsert_interview", () => {
    it("accepts status scheduled and echoes metadata with char counts, not bodies", async () => {
      const p = await position();
      const transcript = "Interviewer: tell me about on-call.\n".repeat(2_500);
      const created = await call("upsert_interview", { idOrSlug: p.id, stage: "technical", status: "scheduled", scheduledAt: "2020-02-03T15:00:00.000Z", transcriptMarkdown: transcript, skipBrief: true });
      expect(created.isError).toBe(false);
      expect(created.data).toMatchObject({ stage: "technical", status: "pending", transcriptChars: transcript.trim().length, briefJobId: null });
      expect(created.data).not.toHaveProperty("transcriptMarkdown");
      expect(created.bytes).toBeLessThan(2_000);

      const patched = await call("upsert_interview", { idOrSlug: p.id, id: created.data.id, status: "completed", outcome: "advanced", verbose: true });
      expect(patched.data).toMatchObject({ id: created.data.id, status: "completed", outcome: "advanced" });
      expect(patched.data.transcriptMarkdown).toBe(transcript.trim());

      const bad = await call("upsert_interview", { idOrSlug: p.id, status: "postponed" });
      expect(bad.isError).toBe(true);
      expect(bad.data.error).toMatch(/scheduled/);
    });
  });
});
