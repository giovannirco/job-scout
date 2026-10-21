import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { apiTokens, closeDb, getDb, positions, timelineEvents } from "@job-scout/db";
import { archivePosition, bootstrap, getPosition, patchPosition, stampCareerOps, upsertFromJob } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-precedence-"));
const original = { ...env };
const credential = "js_test_precedence_credential_value_for_mcp";
let rpcId = 0;

async function call(name: string, args: Record<string, unknown>) {
  const res = await handleMcpHttp(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(res.status).toBe(200);
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  const body = JSON.parse(json) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  return { isError: Boolean(body.result?.isError), text: body.result?.content?.[0]?.text || "" };
}

async function role(name: string, status: "review" | "applied" | "interview" | "screen" = "review") {
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: "1", company: name, title: "Platform Engineer",
    url: `https://boards.greenhouse.io/${name}/jobs/1`, locationRaw: "Remote", descriptionText: "Operate Kubernetes for an example product.", listingStatus: "open" }, { status });
  return position;
}
const events = async (id: string, kind: string) => (await getDb()).select().from(timelineEvents).where(and(eq(timelineEvents.positionId, id), eq(timelineEvents.kind, kind)));
const statusOf = async (id: string) => (await getPosition(id))!.status;

describe("career-ops sync never moves a role backwards", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    // The local sync runs under an agent token (not named career-ops); its writes carry the career-ops note.
    await (await getDb()).insert(apiTokens).values({ id: "token_local", name: "local-agent", scopes: ["mcp"], tokenPrefix: credential.slice(0, 8), tokenHash: await bcrypt.hash(credential, 4) });
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("a stale tracker row (Interview) does not pull a rejected role back via create_position_from_career_ops", async () => {
    const p = await role("stale-interview", "interview");
    await stampCareerOps(p.id, { trackerId: "157", status: "Interview" });
    await patchPosition(p.id, { status: "rejected" }, "operator");
    const r = await call("create_position_from_career_ops", { company: "stale-interview", role: "Platform Engineer", url: p.primaryUrl, trackerId: "157", status: "Interview" });
    expect(r.isError).toBe(false);
    expect(await statusOf(p.id)).toBe("rejected");
    expect((await events(p.id, "status")).map((e) => e.title)).not.toContain("rejected → interview");
    expect((await events(p.id, "note")).map((e) => e.title)).toContain("career-ops says Interview; not applied, job-scout status rejected is terminal");
  });

  it.each([
    ["skipped-then-closed", async (id: string) => { await patchPosition(id, { status: "skip" }, "operator"); await archivePosition(id, "listing_closed 2026-10-01", "operator"); }],
    ["archived-by-operator", async (id: string) => { await archivePosition(id, "not a fit", "operator"); }],
    ["listing-closed", async (id: string) => { await (await getDb()).update(positions).set({ listingStatus: "closed" }).where(eq(positions.id, id)); await archivePosition(id, "listing_closed", "system"); }],
  ])("Evaluated never reopens an archived/closed role (%s) via set_position_status", async (name, archive) => {
    const p = await role(name);
    await archive(p.id);
    const r = await call("set_position_status", { idOrSlug: p.id, status: "review", note: "career-ops sync: tracker #200 is Evaluated" });
    expect(r.isError).toBe(false);
    expect(await statusOf(p.id)).toBe("archived");
    expect((await events(p.id, "status")).map((e) => e.title)).not.toContain("archived → review");
    expect((await events(p.id, "note")).some((e) => e.title.startsWith("career-ops says review; not applied, job-scout status archived is terminal"))).toBe(true);
  });

  it("source=career-ops on update_position cannot move a role to an earlier stage", async () => {
    const p = await role("update-backwards", "interview");
    await call("update_position", { idOrSlug: p.id, status: "applied", source: "career-ops", nextAction: "wait" });
    expect(await getPosition(p.id)).toMatchObject({ status: "interview", nextAction: "wait" });
  });

  it("forward moves from the sync still apply", async () => {
    const a = await role("forward-apply");
    await call("set_position_status", { idOrSlug: a.id, status: "applied", note: "career-ops sync: tracker #301 is Applied" });
    expect(await statusOf(a.id)).toBe("applied");
    await call("set_position_status", { idOrSlug: a.id, status: "rejected", note: "career-ops sync: tracker #301 is Rejected" });
    expect(await statusOf(a.id)).toBe("rejected");
    const b = await role("archived-but-applied");
    await archivePosition(b.id, "triage fail 2.0", "triage");
    await call("set_position_status", { idOrSlug: b.id, status: "applied", note: "career-ops sync: tracker #302 is Applied" });
    expect(await statusOf(b.id)).toBe("applied");
  });

  it("a person (no career-ops origin) can still move a role anywhere", async () => {
    const p = await role("human-move", "interview");
    await patchPosition(p.id, { status: "rejected" }, "operator");
    await call("set_position_status", { idOrSlug: p.id, status: "interview" });
    expect(await statusOf(p.id)).toBe("interview");
  });
});
