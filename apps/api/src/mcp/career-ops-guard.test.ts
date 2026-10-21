import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import { apiTokens, closeDb, getDb, timelineEvents } from "@job-scout/db";
import { bootstrap, getPosition, upsertFromJob } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-career-ops-"));
const original = { ...env };
const token = (name: string) => `js_test_${name}_credential_value_for_mcp_guard_tests`;
let rpcId = 0;

async function call(tokenName: string, name: string, args: Record<string, unknown>) {
  const res = await handleMcpHttp(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token(tokenName)}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(res.status).toBe(200);
  // The response may arrive as JSON or as one SSE "message" event.
  const raw = await res.text();
  const json = raw.trimStart().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  const body = JSON.parse(json) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
  expect(body.error).toBeUndefined();
  return JSON.parse(body.result?.content?.[0]?.text || "null");
}

async function position(name: string, status: "review" | "materials" = "materials") {
  const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: name, jobId: "1", company: `${name} Example`,
    title: "Platform Engineer", url: `https://boards.greenhouse.io/${name}/jobs/1`, locationRaw: "Remote",
    descriptionText: "Operate Kubernetes for an example product.", listingStatus: "open" }, { status });
  return position;
}
const notes = async (id: string) => (await (await getDb()).select().from(timelineEvents).where(and(eq(timelineEvents.positionId, id), eq(timelineEvents.kind, "note"))));

describe("MCP career-ops skip/archive guard", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    const db = await getDb();
    for (const name of ["career-ops-sync", "operator-agent"]) {
      await db.insert(apiTokens).values({ id: `token_${name}`, name, scopes: ["mcp"], tokenPrefix: token(name).slice(0, 8), tokenHash: await bcrypt.hash(token(name), 4) });
    }
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("update_position from a career-ops token notes skip/archived and still applies other fields", async () => {
    const p = await position("upd-guard");
    const r = await call("career-ops-sync", "update_position", { idOrSlug: p.id, status: "skip", notes: "tracker says SKIP" });
    expect(r).toMatchObject({ status: "materials", statusApplied: false, notes: "tracker says SKIP" });
    expect((await getPosition(p.id))!.status).toBe("materials");
    expect((await notes(p.id)).some((e) => e.title === "career-ops says skip; not applied" && e.actor === "career-ops-sync")).toBe(true);
    await call("career-ops-sync", "update_position", { idOrSlug: p.id, status: "archived" });
    expect((await getPosition(p.id))!.status).toBe("materials");
    // Real outcomes still apply.
    expect(await call("career-ops-sync", "update_position", { idOrSlug: p.id, status: "applied" })).toMatchObject({ status: "applied" });
  });

  it("update_position with source=career-ops is guarded for any token", async () => {
    const p = await position("upd-source");
    await call("operator-agent", "update_position", { idOrSlug: p.id, status: "skip", source: "career-ops" });
    expect((await getPosition(p.id))!.status).toBe("materials");
  });

  it("set_match_override human_skip from a career-ops token is noted, not applied", async () => {
    const p = await position("override-guard");
    expect(await call("career-ops-sync", "set_match_override", { idOrSlug: p.id, label: "human_skip" })).toMatchObject({ statusApplied: false });
    expect((await getPosition(p.id))!.status).toBe("materials");
  });

  it("other agents still skip and archive through both tools", async () => {
    const p = await position("operator-upd");
    expect(await call("operator-agent", "update_position", { idOrSlug: p.id, status: "skip" })).toMatchObject({ status: "skip" });
    const q = await position("operator-override");
    expect(await call("operator-agent", "set_match_override", { idOrSlug: q.id, label: "human_skip" })).toMatchObject({ status: "archived", archiveReason: "human_skip" });
  });
});
