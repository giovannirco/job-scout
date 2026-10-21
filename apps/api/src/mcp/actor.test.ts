import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { apiTokens, closeDb, getDb, timelineEvents } from "@job-scout/db";
import { bootstrap, getPosition, patchPosition, upsertFromJob } from "@job-scout/core";
import { createApp } from "../app.js";
import { env } from "../env.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-actor-"));
const original = { ...env };
const token = "js_test_shared_agent_credential_value_for_actor_tests";

async function setStatus(positionId: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await createApp().request("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_position_status", arguments: { idOrSlug: positionId, ...args } } }),
  });
  expect(res.status).toBe(200);
  // Stateless transport may answer as a single SSE message.
  const raw = await res.text();
  const body = JSON.parse(raw.startsWith("event:") ? raw.split("\n").find(l => l.startsWith("data:"))!.slice(5) : raw) as { result?: { isError?: boolean } };
  expect(body.result?.isError).toBeFalsy();
}

async function lastStatusActor(positionId: string) {
  const rows = await (await getDb()).select().from(timelineEvents).where(eq(timelineEvents.positionId, positionId));
  return rows.filter(e => e.kind === "status").sort((a, b) => +a.createdAt - +b.createdAt).at(-1)?.actor;
}

describe("MCP caller attribution", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.authMode = "token"; env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    await (await getDb()).insert(apiTokens).values({ id: "token_shared", name: "shared-agent", scopes: ["mcp"], tokenPrefix: token.slice(0, 8), tokenHash: await bcrypt.hash(token, 4) });
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("allows the actor headers in CORS preflight", async () => {
    const res = await createApp().request("/mcp", { method: "OPTIONS" });
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Job-Scout-Actor");
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Agent-Name");
  });

  it("records the header or argument caller via the token name", async () => {
    const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: "actor-example", company: "Actor Example", jobId: "1", externalIdentity: "greenhouse:actor-example:1",
      title: "Platform Engineer", url: "https://job-boards.greenhouse.io/actor-example/jobs/1", locationRaw: "Remote", descriptionText: "Synthetic job", listingStatus: "open" });

    await setStatus(position.id, { status: "review" });
    expect(await lastStatusActor(position.id)).toBe("shared-agent");

    await setStatus(position.id, { status: "applied" }, { "X-Job-Scout-Actor": "pipeline-sync" });
    expect(await lastStatusActor(position.id)).toBe("pipeline-sync via shared-agent");

    await setStatus(position.id, { status: "review" }, { "X-Agent-Name": "desk-helper" });
    expect(await lastStatusActor(position.id)).toBe("desk-helper via shared-agent");
    expect((await getPosition(position.id))?.metadata?.reviewIntent).toMatchObject({ actor: "desk-helper via shared-agent" });

    await setStatus(position.id, { status: "archived", reason: "test", actor: "cleanup bot" }, { "X-Job-Scout-Actor": "pipeline-sync" });
    expect(await lastStatusActor(position.id)).toBe("cleanup-bot via shared-agent");
  });

  it("keeps automated tokens automated when a caller names itself", async () => {
    const { position } = await upsertFromJob({ provider: "greenhouse", boardToken: "actor-example", company: "Actor Example", jobId: "2", externalIdentity: "greenhouse:actor-example:2",
      title: "Platform Engineer", url: "https://job-boards.greenhouse.io/actor-example/jobs/2", locationRaw: "Remote", descriptionText: "Synthetic job", listingStatus: "open" });
    await patchPosition(position.id, { status: "review" }, "tracker-sync via career-ops");
    expect((await getPosition(position.id))?.metadata?.reviewIntent).toBeUndefined();
    await patchPosition(position.id, { status: "triaged" }, "career-ops");
    await patchPosition(position.id, { status: "review" }, "tracker-sync via shared-agent");
    expect((await getPosition(position.id))?.metadata?.reviewIntent).toMatchObject({ kind: "operator" });
  });
});
