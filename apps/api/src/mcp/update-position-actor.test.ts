import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { apiTokens, closeDb, getDb, positions, timelineEvents } from "@job-scout/db";
import { bootstrap, upsertFromJob } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-actor-"));
const original = { ...env };
const credential = "js_test_actor_credential_value_for_mcp_tests";
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
  const body = JSON.parse(json) as { result?: { isError?: boolean }; error?: unknown };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).toBeFalsy();
}

describe("update_position actor attribution", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    await (await getDb()).insert(apiTokens).values({ id: "token_actor", name: "shared-agent-token", scopes: ["mcp"], tokenPrefix: credential.slice(0, 8), tokenHash: await bcrypt.hash(credential, 4) });
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("records the actor argument as \"<actor> via <token>\" on the override and the timeline", async () => {
    const { position } = await upsertFromJob({
      provider: "greenhouse", boardToken: "exampleco", company: "Example Co", jobId: "7001", externalIdentity: "greenhouse:exampleco:7001",
      title: "Platform Engineer", url: "https://job-boards.greenhouse.io/exampleco/jobs/7001", descriptionText: "Kubernetes platform work.", listingStatus: "open",
    }, { companyName: "Example Co" });
    await call("update_position", { idOrSlug: position.id, workplace: "remote", actor: "mail-executor" });
    const db = await getDb();
    const row = (await db.select().from(positions).where(eq(positions.id, position.id)))[0]!;
    expect((row.metadata as { classificationOverride?: { actor?: string } }).classificationOverride?.actor).toBe("mail-executor via shared-agent-token");
    const events = await db.select().from(timelineEvents).where(eq(timelineEvents.positionId, position.id));
    expect(events.some((e) => e.actor === "mail-executor via shared-agent-token")).toBe(true);
    expect(events.some((e) => e.actor === "shared-agent-token")).toBe(false);
  });
});
