import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { apiTokens, closeDb, getDb, positions } from "@job-scout/db";
import { applySnapshot, bootstrap, getPosition, upsertFromJob } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-urlless-"));
const original = { ...env };
const credential = "js_test_urlless_credential_value_for_mcp_tests";
let rpcId = 0;

type ToolResult = { isError: boolean; data: any };

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
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  return { isError: Boolean(body.result?.isError), data };
}

async function count(): Promise<number> {
  return (await (await getDb()).select({ c: sql<number>`count(*)::int` }).from(positions))[0]?.c ?? 0;
}

describe("career-ops tracker rows without a URL", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    const db = await getDb();
    await db.insert(apiTokens).values({ id: "token_urlless", name: "urlless-agent", scopes: ["mcp"], tokenPrefix: credential.slice(0, 8), tokenHash: await bcrypt.hash(credential, 4) });
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("create_position_from_career_ops creates one manual position, links it on re-run, and takes a later URL on the same position", async () => {
    const before = await count();
    const first = await call("create_position_from_career_ops", { company: "Example Lead Co", role: "Platform Engineer", trackerId: "101", status: "Evaluated" });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ via: "created", manualRecord: true, stamp: { trackerId: "101" } });
    expect(first.data.position).toMatchObject({ primaryUrl: null, title: "Platform Engineer", status: "review", company: { name: "Example Lead Co" } });
    const id = first.data.position.id as string;
    expect(await count()).toBe(before + 1);

    const again = await call("create_position_from_career_ops", { company: "Example Lead Co", role: "Platform Engineer", trackerId: "101", url: "" });
    expect(again.data).toMatchObject({ via: "trackerId", position: { id } });
    // Without the tracker id, the one URL-less position with the same company and role still matches.
    const byRole = await call("create_position_from_career_ops", { company: "example lead co", role: "Platform Engineer" });
    expect(byRole.data).toMatchObject({ via: "company_title", position: { id } });
    expect(await count()).toBe(before + 1);

    const url = "https://boards.greenhouse.io/example-lead-co/jobs/4242";
    const withUrl = await call("create_position_from_career_ops", { company: "Example Lead Co", role: "Platform Engineer", trackerId: "101", url, status: "Applied" });
    expect(withUrl.isError).toBe(false);
    expect(withUrl.data).toMatchObject({ via: "trackerId", urlSet: true, position: { id, primaryUrl: url, status: "applied" } });
    const stored = (await getPosition(id))!;
    expect(stored).toMatchObject({ atsProvider: "greenhouse", primaryUrl: url });
    expect(stored.metadata?.previousUrls).toBeUndefined();
    expect(await count()).toBe(before + 1);
  });

  it("keeps distinct tracker rows apart: other company, or same company and role under another tracker id", async () => {
    const a = await call("create_position_from_career_ops", { company: "Example Referral A", role: "Site Reliability Engineer", trackerId: "201" });
    const b = await call("create_position_from_career_ops", { company: "Example Referral B", role: "Site Reliability Engineer", trackerId: "202" });
    const c = await call("create_position_from_career_ops", { company: "Example Referral A", role: "Site Reliability Engineer", trackerId: "203" });
    const ids = [a, b, c].map((r) => r.data.position.id);
    expect(new Set(ids).size).toBe(3);
    const listed = await call("list_positions", { q: "Example Referral", pageSize: 50 });
    expect(listed.data.items.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(ids));
    // Each re-run follows its own tracker id, even with a twin role at the same company.
    const again = await call("create_position_from_career_ops", { company: "Example Referral A", role: "Site Reliability Engineer", trackerId: "203" });
    expect(again.data).toMatchObject({ via: "trackerId", position: { id: c.data.position.id } });
  });

  it("reports a URL another position already holds instead of creating a duplicate", async () => {
    const { position: other } = await upsertFromJob({ provider: "greenhouse", boardToken: "example-clash", jobId: "77", company: "Example Clash Co",
      title: "Platform Engineer", url: "https://boards.greenhouse.io/example-clash/jobs/77", locationRaw: "Remote",
      descriptionText: "Operate Kubernetes for an example product. " + "z".repeat(400), listingStatus: "open" }, { status: "review" });
    const lead = await call("create_position_from_career_ops", { company: "Example Clash Co", role: "Platform Engineer", trackerId: "301" });
    const before = await count();
    const r = await call("create_position_from_career_ops", { company: "Example Clash Co", role: "Platform Engineer", trackerId: "301", url: other.primaryUrl });
    expect(r.isError).toBe(false);
    expect(r.data.position.id).toBe(lead.data.position.id);
    expect(r.data.position.primaryUrl).toBeNull();
    expect(r.data.urlConflict).toMatch(/^url_conflict:/);
    expect(await count()).toBe(before);
  });

  it("create_position_from_career_ops does not create a position for a dropped row that matches nothing", async () => {
    const before = await count();
    const r = await call("create_position_from_career_ops", { company: "Example Skipped Co", role: "DevOps Engineer", trackerId: "403", status: "SKIP" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ skipped: true, reason: "tracker_dropped", trackerId: "403" });
    expect(await count()).toBe(before);
  });

  it("reconcile_career_ops never creates a position for a row the tracker dropped", async () => {
    const rows = [{ trackerId: 402, company: "Example Dropped Co", title: "Site Reliability Engineer", status: "Discarded" }];
    const before = await count();
    const real = await call("reconcile_career_ops", { rows, dryRun: false });
    expect(real.data).toMatchObject({ created: [], skippedDropped: ["402"], unmatched: ["402"] });
    expect(await count()).toBe(before);
  });

  it("reconcile_career_ops creates URL-less rows once, links them by tracker id, and sets a later URL on the same position", async () => {
    const rows = [{ trackerId: 401, company: "Example Recruiter Co", title: "Infrastructure Engineer", status: "Interview" }];
    const dry = await call("reconcile_career_ops", { rows });
    expect(dry.data).toMatchObject({ dryRun: true, unmatched: ["401"], wouldCreate: ["401"], created: [] });
    const before = await count();
    const real = await call("reconcile_career_ops", { rows, dryRun: false });
    expect(real.data.created).toHaveLength(1);
    expect(real.data.unmatched).toEqual([]);
    const id = real.data.created[0].positionId as string;
    expect((await getPosition(id))).toMatchObject({ primaryUrl: null, status: "interview", title: "Infrastructure Engineer" });
    expect((await getPosition(id))?.metadata?.careerOps).toMatchObject({ trackerId: "401", status: "Interview" });
    expect(await count()).toBe(before + 1);

    const rerun = await call("reconcile_career_ops", { rows, dryRun: false });
    expect(rerun.data).toMatchObject({ created: [], matches: [{ trackerId: "401", positionIds: [id], via: "trackerId" }] });
    expect(await count()).toBe(before + 1);

    const url = "https://jobs.ashbyhq.com/example-recruiter-co/5a5a5a5a-0000-4000-8000-000000000401";
    const preview = await call("reconcile_career_ops", { rows: [{ ...rows[0], url }] });
    expect(preview.data).toMatchObject({ urlSet: [{ trackerId: "401", positionId: id, url }] });
    expect((await getPosition(id))?.primaryUrl).toBeNull();
    const linked = await call("reconcile_career_ops", { rows: [{ ...rows[0], url }], dryRun: false });
    expect(linked.data).toMatchObject({ matches: [{ trackerId: "401", positionIds: [id], via: "trackerId" }], urlSet: [{ positionId: id }], conflicts: [] });
    expect((await getPosition(id))?.primaryUrl).toBe(url);
    // The URL now identifies it, so the next run still links the same position.
    const after = await call("reconcile_career_ops", { rows: [{ ...rows[0], url }], dryRun: false });
    expect(after.data).toMatchObject({ matches: [{ positionIds: [id] }], urlSet: [], created: [] });
    expect(await count()).toBe(before + 1);
  });

  it("a URL-less position that later gets its JD does not show a changed badge", async () => {
    const lead = await call("create_position_from_career_ops", { company: "Example Badge Co", role: "Platform Engineer", trackerId: "501" });
    const id = lead.data.position.id as string;
    const url = "https://boards.greenhouse.io/example-badge-co/jobs/501";
    expect((await call("create_position_from_career_ops", { company: "Example Badge Co", role: "Platform Engineer", trackerId: "501", url })).data.urlSet).toBe(true);
    await applySnapshot({ positionId: id, source: "refresh", job: {
      provider: "greenhouse", boardToken: "example-badge-co", jobId: "501", company: "Example Badge Co", title: "Platform Engineer", url,
      locationRaw: "Remote", descriptionText: "Operate Kubernetes for an example product. " + "q".repeat(600), listingStatus: "open",
    } });
    expect((await getPosition(id))?.listingStatus).not.toBe("changed");
  });
});
