import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { eq, inArray, sql } from "drizzle-orm";
import { apiTokens, closeDb, evaluations, getDb, id as newId, positions } from "@job-scout/db";
import { applySnapshot, bootstrap, getPosition, harvestFromJob, listEvents, runListingClassify, stampCareerOps, upsertFromJob } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";
import { fitPage } from "./page.js";

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
  let data: any;
  try { data = JSON.parse(text); } catch { data = { error: text }; } // SDK input-validation errors are plain text
  return { raw: text, bytes: Buffer.byteLength(text), isError: Boolean(body.result?.isError), data };
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

  describe("list_positions paging", () => {
    const ids: string[] = [];
    beforeAll(async () => {
      for (let i = 0; i < 12; i++) ids.push((await position({ title: `Paging Probe Engineer ${String(i).padStart(2, "0")}` })).id);
      const db = await getDb();
      // Ties at microsecond precision: the cursor must not drop or repeat rows that share updated_at.
      await db.update(positions).set({ updatedAt: sql`'2026-01-01 00:00:00.123456+00'::timestamptz` }).where(inArray(positions.id, ids.slice(0, 6)));
      await db.update(positions).set({ updatedAt: sql`'2026-01-01 00:00:00.123999+00'::timestamptz`, triageScore: 4.2 }).where(inArray(positions.id, ids.slice(6, 9)));
    });

    async function drain(args: Record<string, unknown>) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await call("list_positions", { q: "Paging Probe", pageSize: 5, ...args, ...(cursor ? { cursor } : {}) });
        expect(r.isError).toBe(false);
        expect(r.data.total).toBe(12);
        seen.push(...r.data.items.map((x: { id: string }) => x.id));
        cursor = r.data.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);
      return { seen, pages };
    }

    it.each([{}, { sort: "score_desc" }, { sort: "title_asc" }, { sort: "updated_asc" }, { sort: "first_seen_asc" }])("visits every row exactly once with %o", async (args) => {
      const { seen, pages } = await drain(args);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(12);
      expect(new Set(seen)).toEqual(new Set(ids));
    });

    it("returns nextCursor while rows remain and null on the last page", async () => {
      const first = await call("list_positions", { q: "Paging Probe", pageSize: 12 });
      expect(first.data.items).toHaveLength(12);
      expect(first.data.nextCursor).toBeNull();
      const partial = await call("list_positions", { q: "Paging Probe", pageSize: 11 });
      expect(typeof partial.data.nextCursor).toBe("string");
    });

    it("lean rows leave out heavy fields; fields=full keeps them", async () => {
      const lean = await call("list_positions", { q: "Paging Probe", pageSize: 1 });
      const row = lean.data.items[0];
      expect(row).toMatchObject({ id: expect.any(String), slug: expect.any(String), status: "review", company: { name: expect.any(String) } });
      for (const k of ["triageJson", "metadata", "departments", "locationRaw", "salaryMin", "repost", "postedAt"]) expect(row).not.toHaveProperty(k);
      const full = await call("list_positions", { q: "Paging Probe", pageSize: 1, fields: "full" });
      expect(full.data.items[0]).toHaveProperty("locationRaw");
      expect(full.data.items[0]).not.toHaveProperty("triageJson");
    });

    it("refuses a cursor replayed with other filters or sort", async () => {
      const first = await call("list_positions", { q: "Paging Probe", pageSize: 5 });
      const other = await call("list_positions", { q: "Paging Probe", pageSize: 5, sort: "score_desc", cursor: first.data.nextCursor });
      expect(other.isError).toBe(true);
      expect(other.data.code).toBe("invalid_cursor");
      const garbage = await call("list_positions", { q: "Paging Probe", cursor: "not-a-cursor" });
      expect(garbage).toMatchObject({ isError: true, data: { code: "invalid_cursor" } });
    });

    it("fitPage cuts a page to the byte budget and resumes after the last row kept", () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, pad: "x".repeat(100) }));
      const cursors = rows.map((r) => `after-${r.id}`);
      const cut = fitPage(rows, cursors, "after-r9", 400);
      expect(cut.truncated).toBe(true);
      expect(cut.items.length).toBe(3);
      expect(cut.nextCursor).toBe("after-r2");
      expect(fitPage(rows, cursors, null, 1_000_000)).toEqual({ items: rows, nextCursor: null, truncated: false });
      expect(fitPage(rows, cursors, null, 10).items).toHaveLength(1);
    });

    it("a large page stays under the result cap", async () => {
      const db = await getDb();
      await db.update(positions).set({ triageJson: { oneLiner: "n".repeat(12_000) } }).where(inArray(positions.id, ids));
      const r = await call("list_positions", { q: "Paging Probe", pageSize: 200, fields: "full" });
      expect(r.isError).toBe(false);
      expect(r.bytes).toBeLessThan(100_000);
      expect(r.data.truncated).toBe(true);
      const rest = await call("list_positions", { q: "Paging Probe", pageSize: 200, fields: "full", cursor: r.data.nextCursor });
      expect(r.data.items.length + rest.data.items.length).toBe(12);
    });
  });

  describe("list_changes", () => {
    const pause = (ms = 15) => new Promise((r) => setTimeout(r, ms));
    const job = (board: string, n: number) => ({
      provider: "greenhouse" as const, boardToken: board, jobId: String(n), company: `Changes Co ${board}`, title: "Changes Probe Engineer",
      url: `https://boards.greenhouse.io/${board}/jobs/${n}`, locationRaw: "Remote", descriptionText: "Operate Kubernetes for an example product. " + "z".repeat(400), listingStatus: "open" as const,
    });

    it("leaves updatedAt alone for unchanged checks, form harvests and career-ops stamps", async () => {
      const { position: p } = await upsertFromJob(job("changes-noop", 1), { status: "review" });
      const before = (await getPosition(p.id))!.updatedAt.getTime();
      await pause();
      const r = await applySnapshot({ positionId: p.id, job: job("changes-noop", 1), source: "watch" });
      expect(r.changed).toBe(false);
      await harvestFromJob(p.id, { ...job("changes-noop", 1), questionPrompts: [] });
      await stampCareerOps(p.id, { trackerId: "T-1", status: "Evaluated" });
      const after = (await getPosition(p.id))!;
      expect(after.updatedAt.getTime()).toBe(before);
      expect(after.lastCheckedAt!.getTime()).toBeGreaterThan(before);
      await call("update_position", { idOrSlug: p.id, nextAction: "email the example recruiter" });
      expect((await getPosition(p.id))!.updatedAt.getTime()).toBeGreaterThan(before);
    });

    it("lists only rows changed after since, pages positions then evaluations, and keeps now fixed", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await upsertFromJob(job(`changes-page-${i}`, 10 + i), { status: "review" })).position.id);
      const quiet = (await upsertFromJob(job("changes-quiet", 99), { status: "review" })).position.id;
      await pause();
      const since = new Date().toISOString();
      await pause();
      for (const pid of ids) await call("update_position", { idOrSlug: pid, notes: "touched by a person" });
      // An unchanged watch check on another row after `since` is not a change.
      await applySnapshot({ positionId: quiet, job: job("changes-quiet", 99), source: "watch" });
      const db = await getDb();
      for (const pid of ids.slice(0, 3)) await db.insert(evaluations).values({ id: newId("ev"), positionId: pid, kind: "evaluate", model: "example-model", markdown: "ok", json: {} });

      const pages: any[] = [];
      let cursor: string | undefined;
      do {
        const r = await call("list_changes", { since, limit: 2, ...(cursor ? { cursor } : {}) });
        expect(r.isError).toBe(false);
        pages.push(r.data);
        cursor = r.data.nextCursor ?? undefined;
      } while (cursor && pages.length < 10);
      const seen = pages.flatMap((p) => p.positions.map((x: { id: string }) => x.id));
      expect(seen.sort()).toEqual([...ids].sort());
      expect(seen).not.toContain(quiet);
      expect(pages.flatMap((p) => p.evaluations)).toHaveLength(3);
      // positions are drained before evaluations start
      const firstEvalPage = pages.findIndex((p) => p.evaluations.length);
      expect(pages.slice(firstEvalPage + 1).every((p) => p.positions.length === 0)).toBe(true);
      expect(new Set(pages.map((p) => p.now)).size).toBe(1);
      const row = pages[0].positions[0];
      expect(row).toHaveProperty("lastChangedAt");
      for (const k of ["triageJson", "departments", "locationRaw", "metadata"]) expect(row).not.toHaveProperty(k);

      const again = await call("list_changes", { since: pages[0].now });
      expect(again.data.positions.map((x: { id: string }) => x.id)).not.toContain(quiet);
    });

    it("cuts a large page to the result cap and refuses a cursor for another since", async () => {
      const since = new Date(0).toISOString();
      const db = await getDb();
      await db.update(positions).set({ triageJson: { oneLiner: "m".repeat(4_000) } });
      const r = await call("list_changes", { since, limit: 500, fields: "full" });
      expect(r.isError).toBe(false);
      expect(r.bytes).toBeLessThan(100_000);
      expect(r.data.truncated).toBe(true);
      expect(typeof r.data.nextCursor).toBe("string");
      const next = await call("list_changes", { since, limit: 500, fields: "full", cursor: r.data.nextCursor });
      expect(next.isError).toBe(false);
      const ids = new Set(r.data.positions.map((x: { id: string }) => x.id));
      expect(next.data.positions.some((x: { id: string }) => ids.has(x.id))).toBe(false);
      const wrong = await call("list_changes", { since: new Date(1).toISOString(), cursor: r.data.nextCursor });
      expect(wrong).toMatchObject({ isError: true, data: { code: "invalid_cursor" } });
    });
  });

  describe("update_position listing corrections", () => {
    const edits = async (pid: string) => (await listEvents(pid, 50)).filter((e) => e.kind === "edit");

    it("retitles and reslugs, keeping the old slug resolvable", async () => {
      const p = await position({ title: "Platfrom Engneer" });
      const r = await call("update_position", { idOrSlug: p.slug, title: "Staff Platform Engineer" });
      expect(r.isError).toBe(false);
      expect(r.data.title).toBe("Staff Platform Engineer");
      expect(r.data.slug).not.toBe(p.slug);
      expect(r.data.slug).toContain("staff-platform-engineer");
      const viaOld = await call("get_position", { idOrSlug: p.slug, includeJd: false });
      expect(viaOld.data.id).toBe(p.id);
      expect(viaOld.data.metadata.previousSlugs).toContain(p.slug);
      expect((await edits(p.id)).map((e) => e.title)).toContain("title: Platfrom Engneer → Staff Platform Engineer");
      expect((await call("update_position", { idOrSlug: p.id, title: "  " })).isError).toBe(true);
    });

    it("validates and re-points primaryUrl, keeping the old URL in history", async () => {
      const p = await position({ board: "example-url-old" });
      const other = await position({ board: "example-url-taken" });
      for (const bad of ["http://localhost/jobs/1", "http://10.0.0.5/jobs/1", "ftp://example.com/jobs/1", "not a url"]) {
        const r = await call("update_position", { idOrSlug: p.id, primaryUrl: bad });
        expect(r.isError).toBe(true);
        expect(r.data.error).toMatch(/^invalid_url/);
      }
      const clash = await call("update_position", { idOrSlug: p.id, primaryUrl: other.primaryUrl });
      expect(clash.isError).toBe(true);
      expect(clash.data.error).toMatch(/^url_conflict/);

      const next = "https://jobs.ashbyhq.com/example-url-new/0b6c3f6e-1111-4c2a-9d7e-123456789abc";
      const r = await call("update_position", { idOrSlug: p.id, primaryUrl: next, verbose: true });
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ primaryUrl: next, atsProvider: "ashby" });
      expect(r.data.externalIdentity).toContain("ashby");
      expect(r.data.metadata.previousUrls).toEqual([p.primaryUrl]);
      expect((await edits(p.id)).some((e) => e.title.startsWith("primaryUrl:"))).toBe(true);
    });

    it("records workplace/geo as a human override that snapshots and listing_classify keep", async () => {
      const p = await position({ board: "example-override" });
      const r = await call("update_position", { idOrSlug: p.id, workplace: "hybrid", geoClass: "hard_geo", geoNotes: "office days in an example city" });
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ workplace: "hybrid", geoClass: "hard_geo", geoNotes: "office days in an example city" });
      expect(r.data.classificationOverride).toMatchObject({ workplace: "hybrid", geoClass: "hard_geo", actor: "contract-agent" });
      expect((await edits(p.id)).map((e) => e.title)).toEqual(expect.arrayContaining(["workplace: remote → hybrid"]));

      // A material JD change with a remote location recomputes facts; the override wins on the position.
      const changed = await applySnapshot({ positionId: p.id, source: "watch", job: {
        provider: "greenhouse", boardToken: "example-override", jobId: p.atsJobId!, company: p.company.name, title: p.title, url: p.primaryUrl!,
        locationRaw: "Remote - Worldwide", descriptionText: "A rewritten description for an example product, fully remote. " + "w".repeat(600), listingStatus: "open",
      } });
      expect(changed.changed).toBe(true);
      const after = (await getPosition(p.id))!;
      expect(after.workplace).toBe("hybrid");
      expect(after.geoClass).toBe("hard_geo");
      expect(await runListingClassify(p.id)).toMatchObject({ skipped: true, reason: "human_override" });

      const bad = await call("update_position", { idOrSlug: p.id, workplace: "moon" });
      expect(bad.isError).toBe(true);
    });
  });
});
