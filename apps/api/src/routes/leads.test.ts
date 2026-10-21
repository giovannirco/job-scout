import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), ".data", "pglite-leads-test");

type Envelope<T> = { ok: boolean; data: T; error?: { code: string; message: string; details?: Record<string, unknown> }; meta?: Record<string, unknown> };
type LeadOut = { id: string; status: string; bucket: string | null; threadUrls: string[]; positionId: string | null; leadTriage: { verdict: string; pay: { status: string; usdYearlyMax: number | null } }; messages: { body: string; direction: string }[] };

describe("leads REST API on pglite", () => {
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>>;

  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.PGLITE_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = "dev";
    const { bootstrap, updateProfile } = await import("@job-scout/core");
    await bootstrap({ seedBoards: false });
    await updateProfile({ cashFloorUsd: 140_000 });
    const { createApp } = await import("../app.js");
    app = createApp();
  });

  afterAll(async () => {
    const { closeDb } = await import("@job-scout/db");
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function req<T>(method: string, url: string, body?: unknown): Promise<{ status: number; env: Envelope<T> }> {
    const res = await app.request(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, env: (await res.json()) as Envelope<T> };
  }

  it("creates, dedupes, patches, lists and logs messages", async () => {
    const created = await req<LeadOut>("POST", "/api/v1/leads", {
      recruiterName: "Morgan Sample", recruiterCompany: "Bluefield Search", recruiterProfileUrl: "https://example.com/in/morgan-sample",
      pitchedRole: "Senior DevOps Engineer", statedPay: "$110k", threadUrl: "https://example.com/thread/1",
    });
    expect(created.status).toBe(201);
    expect(created.env.meta?.created).toBe(true);
    expect(created.env.data.leadTriage.pay).toMatchObject({ status: "below_floor", usdYearlyMax: 110_000 });
    const id = created.env.data.id;

    const again = await req<LeadOut>("POST", "/api/v1/leads", { recruiterProfileUrl: "https://www.example.com/in/morgan-sample/", pitchedRole: "Senior DevOps Engineer", threadUrl: "https://example.com/thread/2" });
    expect(again.status).toBe(200);
    expect(again.env.data.id).toBe(id);
    expect(again.env.data.threadUrls).toHaveLength(2);

    const patched = await req<LeadOut>("PATCH", `/api/v1/leads/${id}`, { status: "vetted", openUnknowns: ["client name"] });
    expect(patched.env.data.status).toBe("vetted");
    expect((await req("PATCH", `/api/v1/leads/${id}`, { status: "hired" })).status).toBe(400);
    expect((await req("PATCH", "/api/v1/leads/lead_missing", { status: "vetted" })).status).toBe(404);

    const msg = await req<{ body: string }>("POST", `/api/v1/leads/${id}/messages`, { direction: "inbound", body: "Text me on +1 (555) 555-0188 please" });
    expect(msg.status).toBe(201);
    expect(msg.env.data.body).toBe("Text me on [phone] please");
    expect((await req("POST", `/api/v1/leads/${id}/messages`, { body: "no direction" })).status).toBe(400);

    const list = await req<{ id: string; bucket: string }[]>("GET", "/api/v1/leads?lane=needs_reply");
    expect(list.env.data.map((r) => r.id)).toContain(id);
    expect((await req("GET", "/api/v1/leads?lane=nope")).status).toBe(400);

    const got = await req<LeadOut>("GET", `/api/v1/leads/${id}`);
    expect(got.env.data.messages[0]).toMatchObject({ direction: "inbound", body: "Text me on [phone] please" });
  });

  it("pages leads with a cursor", async () => {
    for (let n = 0; n < 3; n++) await req("POST", "/api/v1/leads", { recruiterName: `Pager ${n}`, recruiterCompany: "Paging Talent", pitchedRole: "SRE" });
    const first = await req<{ id: string }[]>("GET", "/api/v1/leads?q=Pager&pageSize=2");
    expect(first.env.data).toHaveLength(2);
    expect(first.env.meta?.total).toBe(3);
    const cursor = first.env.meta?.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await req<{ id: string }[]>("GET", `/api/v1/leads?q=Pager&pageSize=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.env.data).toHaveLength(1);
    expect(second.env.meta?.nextCursor).toBeNull();
    expect(new Set([...first.env.data, ...second.env.data].map((r) => r.id)).size).toBe(3);
    expect((await req("GET", `/api/v1/leads?q=Other&cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });

  it("shows a lead interview in upcoming and on Today, then promotes the lead to a position", async () => {
    const lead = (await req<LeadOut>("POST", "/api/v1/leads", { recruiterName: "Avery Placeholder", recruiterCompany: "Summit Recruiting", pitchedRole: "Platform Lead", clientHint: "Fabrikam Fictional" })).env.data;
    const when = new Date(Date.now() + 6 * 3600_000).toISOString();
    const iv = await req<{ id: string; leadId: string; positionId: string | null }>("POST", `/api/v1/leads/${lead.id}/interviews`, { stage: "recruiter_screen", scheduledAt: when });
    expect(iv.status).toBe(201);
    expect(iv.env.data).toMatchObject({ leadId: lead.id, positionId: null });

    const upcoming = await req<{ id: string; leadId: string | null; companyName: string | null }[]>("GET", "/api/v1/interviews?lane=upcoming");
    expect(upcoming.env.data.find((r) => r.id === iv.env.data.id)).toMatchObject({ leadId: lead.id, companyName: "Fabrikam Fictional" });
    const today = await req<{ upcoming: { id: string; slug: string | null; title: string; company: string }[] }>("GET", "/api/v1/today");
    expect(today.env.data.upcoming.find((r) => r.id === iv.env.data.id)).toMatchObject({ slug: null, title: "Platform Lead", company: "Fabrikam Fictional" });
    const rounds = await req<{ id: string }[]>("GET", `/api/v1/leads/${lead.id}/interviews`);
    expect(rounds.env.data.map((r) => r.id)).toEqual([iv.env.data.id]);
    const done = await req<{ status: string }>("PATCH", `/api/v1/leads/${lead.id}/interviews/${iv.env.data.id}`, { status: "completed", outcome: "advanced" });
    expect(done.env.data.status).toBe("completed");
    expect((await req<LeadOut>("GET", `/api/v1/leads/${lead.id}`)).env.data.status).toBe("screened");

    expect((await req("POST", `/api/v1/leads/${lead.id}/actions/promote`, {})).status).toBe(400);
    const promoted = await req<{ positionId: string; created: boolean; lead: LeadOut }>("POST", `/api/v1/leads/${lead.id}/actions/promote`, { url: "https://jobs.lever.co/fabrikamfictional/abc-123", fetch: false });
    expect(promoted.status).toBe(200);
    expect(promoted.env.data.lead).toMatchObject({ status: "promoted", positionId: promoted.env.data.positionId });
    const posRounds = await req<{ id: string }[]>("GET", `/api/v1/positions/${promoted.env.data.positionId}/interviews`);
    expect(posRounds.env.data.map((r) => r.id)).toEqual([iv.env.data.id]);

    const other = (await req<LeadOut>("POST", "/api/v1/leads", { recruiterName: "Avery Placeholder", recruiterCompany: "Summit Recruiting", pitchedRole: "Platform Lead (EU)" })).env.data;
    const linked = await req<LeadOut>("POST", `/api/v1/leads/${other.id}/actions/link-position`, { positionIdOrSlug: promoted.env.data.positionId });
    expect(linked.env.data).toMatchObject({ positionId: promoted.env.data.positionId, status: "new" });
    expect((await req("POST", `/api/v1/leads/${other.id}/actions/link-position`, { positionIdOrSlug: "pos_missing" })).status).toBe(404);

    const merged = await req<LeadOut>("POST", `/api/v1/leads/${lead.id}/actions/merge`, { sourceIds: [other.id] });
    expect(merged.status).toBe(200);
    expect((await req<{ status: string }>("GET", `/api/v1/leads/${other.id}`)).env.data.status).toBe("closed");
  });
});
