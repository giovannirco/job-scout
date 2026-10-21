import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { apiTokens, closeDb, getDb, jobs, notificationOutbox, outreachEvents } from "@job-scout/db";
import { bootstrap, updateProfile } from "@job-scout/core";
import { env } from "../env.js";
import { handleMcpHttp } from "./handler.js";
import { compactArgs } from "./server.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-mcp-leads-"));
const original = { ...env };
const credential = "js_test_leads_credential_value_for_mcp_tests";
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

const RECRUITER = { recruiterName: "Dana Fictional", recruiterCompany: "Talent Bridge Partners", recruiterProfileUrl: "https://www.example.com/in/dana-fictional/", source: "linkedin" };

describe("recruiter leads over MCP", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL; process.env.PGLITE_DATA_DIR = dir;
    env.apiTokenSeed = "";
    await bootstrap({ seedBoards: false });
    await updateProfile({ cashFloorUsd: 150_000, masterResumeMarkdown: "Kubernetes, Terraform and AWS platform work." });
    const db = await getDb();
    await db.insert(apiTokens).values({ id: "token_leads", name: "leads-agent", scopes: ["mcp"], tokenPrefix: credential.slice(0, 8), tokenHash: await bcrypt.hash(credential, 4) });
  });
  afterAll(async () => { Object.assign(env, original); await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("creates, reads, patches and lists a lead; two threads from the same recruiter collapse into one", async () => {
    const first = await call("upsert_lead", {
      ...RECRUITER, pitchedRole: "Senior Platform Engineer (Kubernetes)", threadUrl: "https://example.com/messaging/thread/aaa",
      message: { direction: "inbound", body: "Hi! Remote role for a fintech client. Call me at +1 555-555-0142 or dana.talent@example.com" },
    });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ created: true, status: "new", bucket: "needs_reply", pitchedRole: "Senior Platform Engineer (Kubernetes)" });
    expect(first.data.leadTriage.verdict).toBe("hold");
    expect(first.data.leadTriage.unknowns).toEqual(expect.arrayContaining(["client", "pay"]));
    expect(first.data.messages[0].body).toBe("Hi! Remote role for a fintech client. Call me at [phone] or [email]");

    const second = await call("upsert_lead", {
      recruiterProfileUrl: "example.com/in/Dana-Fictional", pitchedRole: "senior platform engineer kubernetes",
      threadUrl: "https://example.com/messaging/thread/bbb", clientHint: "Series B fintech",
    });
    expect(second.data.created).toBe(false);
    expect(second.data.id).toBe(first.data.id);
    expect(second.data.threadUrls).toEqual(["https://example.com/messaging/thread/aaa", "https://example.com/messaging/thread/bbb"]);
    expect(second.data.clientHint).toBe("Series B fintech");
    expect(second.data.recruiterName).toBe("Dana Fictional");

    const patched = await call("upsert_lead", { id: first.data.id, status: "vetted", nextAction: "ask for the JD" });
    expect(patched.data).toMatchObject({ id: first.data.id, status: "vetted", nextAction: "ask for the JD" });

    const got = await call("get_lead", { id: first.data.id });
    expect(got.data.messages).toHaveLength(1);
    expect(got.data.recruiterProfileUrl).toBe("https://www.example.com/in/dana-fictional/");

    const listed = await call("list_leads", {});
    expect(listed.data.items.map((r: { id: string }) => r.id)).toContain(first.data.id);
    const row = listed.data.items.find((r: { id: string }) => r.id === first.data.id);
    expect(row).toMatchObject({ threadCount: 2, bucket: "needs_reply" });
    expect(row).not.toHaveProperty("recruiterPhone");
    expect(row).not.toHaveProperty("recruiterEmail");
  });

  it("logs messages with direction, redacts phones and moves buckets; never queues a send", async () => {
    const { data: lead } = await call("upsert_lead", { ...RECRUITER, pitchedRole: "SRE Lead", recruiterPhone: "+1 555 555 0100" });
    const out = await call("log_lead_message", { id: lead.id, direction: "outbound", body: "Thanks, my number is 155 555 50177, send the JD" });
    expect(out.data).toMatchObject({ direction: "outbound", body: "Thanks, my number is [phone], send the JD" });
    const after = await call("get_lead", { id: lead.id });
    expect(after.data).toMatchObject({ status: "replied", bucket: "waiting", recruiterPhone: "+1 555 555 0100" });
    const db = await getDb();
    const stored = await db.select({ body: outreachEvents.body }).from(outreachEvents).where(eq(outreachEvents.leadId, lead.id));
    expect(stored.map((r) => r.body).join(" ")).not.toMatch(/555/);
    expect(await db.select().from(notificationOutbox)).toEqual([]);
    expect((await call("log_lead_message", { id: lead.id, direction: "sideways", body: "x" })).isError).toBe(true);
  });

  it("keeps phone numbers out of logged tool arguments", () => {
    const logged = JSON.stringify(compactArgs({ id: "lead_x", body: "call +1 555-555-0142" }, "log_lead_message"));
    expect(logged).not.toMatch(/555-555-0142/);
    expect(logged).toContain("[phone]");
    expect(compactArgs({ idOrSlug: "pos_1", note: "+1 555-555-0142" }, "update_position")).toEqual({ idOrSlug: "pos_1", note: "+1 555-555-0142" });
  });

  it("passes a lead under the floor through without inventing a USD figure", async () => {
    const under = await call("upsert_lead", { ...RECRUITER, pitchedRole: "DevOps Engineer", statedPay: "$90,000 per year", statedGeo: "Remote, LATAM", statedContract: "contractor", clientHint: "health tech" });
    expect(under.data.status).toBe("new");
    expect(under.data.leadTriage.pay).toEqual({ status: "below_floor", usdYearlyMax: 90_000, floorUsd: 150_000 });
    expect(under.data.leadTriage.verdict).toBe("fail");
    const brl = await call("upsert_lead", { ...RECRUITER, pitchedRole: "Cloud Engineer", statedPay: "R$ 18.000 por mês", statedGeo: "Remote Brazil", statedContract: "PJ", clientHint: "bank" });
    expect(brl.data.leadTriage.pay).toMatchObject({ status: "not_comparable", usdYearlyMax: null });
    expect(brl.data.status).toBe("new");
    const db = await getDb();
    expect(await db.select().from(notificationOutbox)).toEqual([]);
  });

  it("an interview on a lead shows in upcoming interviews and the work queue, then promote links it to the position", async () => {
    const { data: lead } = await call("upsert_lead", { ...RECRUITER, pitchedRole: "Staff Infrastructure Engineer", clientHint: "Northwind Logistics" });
    const when = new Date(Date.now() + 24 * 3600_000).toISOString();
    const iv = await call("upsert_interview", { leadId: lead.id, stage: "recruiter_screen", title: "Intro call", scheduledAt: when, interviewerName: "Dana Fictional" });
    expect(iv.isError).toBe(false);
    expect(iv.data).toMatchObject({ positionId: null, leadId: lead.id, status: "pending" });
    const db = await getDb();
    expect(await db.select().from(jobs).where(eq(jobs.type, "interview_brief"))).toEqual([]);

    const upcoming = await call("list_all_interviews", { lane: "upcoming" });
    const round = upcoming.data.find((r: { id: string }) => r.id === iv.data.id);
    expect(round).toMatchObject({ leadId: lead.id, positionId: null, leadRole: "Staff Infrastructure Engineer", companyName: "Northwind Logistics" });

    const queue = await call("work_queue", { lane: "leads" });
    const queued = queue.data.leads.find((l: { id: string }) => l.id === lead.id);
    expect(queued).toMatchObject({ bucket: "call_soon", status: "screening_scheduled" });
    expect(queue.data.pagination.leads.total).toBeGreaterThan(0);

    const missing = await call("promote_lead", { id: lead.id });
    expect(missing.isError).toBe(true);
    const promoted = await call("promote_lead", { id: lead.id, url: "https://boards.greenhouse.io/northwindfictional/jobs/4242", fetch: false });
    expect(promoted.isError).toBe(false);
    expect(promoted.data.created).toBe(true);
    expect(promoted.data.lead).toMatchObject({ status: "promoted", positionId: promoted.data.positionId, bucket: null });
    const pos = await call("get_position", { idOrSlug: promoted.data.positionId, includeJd: false });
    expect(pos.data).toMatchObject({ title: "Staff Infrastructure Engineer" });
    const rounds = await call("list_interviews", { idOrSlug: promoted.data.positionId });
    expect(rounds.data.map((r: { id: string }) => r.id)).toEqual([iv.data.id]);
    const active = await call("list_leads", {});
    expect(active.data.items.map((r: { id: string }) => r.id)).not.toContain(lead.id);
  });

  it("links and merges leads", async () => {
    const a = (await call("upsert_lead", { recruiterName: "Riley Example", recruiterCompany: "Harbor Talent", pitchedRole: "Platform Engineer", threadUrl: "https://example.com/t/1" })).data;
    const b = (await call("upsert_lead", { recruiterEmail: "riley.harbor@example.com", pitchedRole: "Platform Eng.", clientHint: "Contoso Fictional", threadUrl: "https://example.com/t/2" })).data;
    await call("log_lead_message", { id: b.id, direction: "inbound", body: "Following up by email" });
    const merged = await call("merge_leads", { id: a.id, sourceIds: [b.id] });
    expect(merged.isError).toBe(false);
    expect(merged.data).toMatchObject({ id: a.id, clientHint: "Contoso Fictional", threadUrls: ["https://example.com/t/1", "https://example.com/t/2"] });
    expect(merged.data.messages).toHaveLength(1);
    const loser = await call("get_lead", { id: b.id });
    expect(loser.data).toMatchObject({ status: "closed", mergedIntoId: a.id, closedReason: "merged" });

    const target = (await call("upsert_lead", { ...RECRUITER, pitchedRole: "Infra Engineer", clientHint: "Contoso Fictional" })).data;
    const pos = (await call("promote_lead", { id: target.id, url: "https://boards.greenhouse.io/contosofictional/jobs/77", fetch: false })).data.positionId;
    const linked = await call("link_lead_position", { id: a.id, positionIdOrSlug: pos });
    expect(linked.data).toMatchObject({ id: a.id, positionId: pos, status: "new" });
  });
});
