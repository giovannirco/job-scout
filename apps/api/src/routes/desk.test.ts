import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AtsJob } from "@job-scout/ats";

const dataDir = path.join(process.cwd(), ".data", "pglite-desk-test");

function job(over: Partial<AtsJob> = {}): AtsJob {
  return {
    provider: "greenhouse",
    boardToken: "acme",
    jobId: "123",
    externalIdentity: "greenhouse:acme:123",
    title: "Senior Platform Engineer",
    company: "Acme",
    url: "https://boards.greenhouse.io/acme/jobs/123",
    locationRaw: "Remote - LATAM",
    descriptionText: "We run Kubernetes on EKS with Terraform and Argo CD. " + "x".repeat(300),
    salaryRaw: "$150,000 - $190,000",
    listingStatus: "open",
    ...over,
  };
}

type Envelope<T> = { ok: boolean; data: T; error?: { message: string }; meta?: Record<string, unknown> };

describe("desk API on pglite", () => {
  let app: Awaited<ReturnType<typeof import("../app.js").createApp>>;
  let acmeId: string;
  let acmeSlug: string;
  let zetaId: string;

  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.PGLITE_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    process.env.AUTH_MODE = "dev";
    const { bootstrap } = await import("@job-scout/core");
    await bootstrap({ seedBoards: false });
    const { createApp } = await import("../app.js");
    const { upsertFromJob } = await import("@job-scout/core");
    app = createApp();
    const acme = await upsertFromJob(job(), { source: "test", companyName: "Acme" });
    const zeta = await upsertFromJob(
      job({
        jobId: "z1",
        externalIdentity: "greenhouse:zeta:z1",
        company: "Zeta",
        url: "https://boards.greenhouse.io/zeta/jobs/z1",
        title: "Staff SRE",
      }),
      { source: "test", companyName: "Zeta" },
    );
    acmeId = acme.position.id;
    acmeSlug = acme.position.slug;
    zetaId = zeta.position.id;
  });

  afterAll(async () => {
    const { closeDb } = await import("@job-scout/db");
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function json<T>(res: Response): Promise<Envelope<T>> {
    return (await res.json()) as Envelope<T>;
  }

  it("people CRUD is scoped to the position company", async () => {
    const created = await app.request(`/api/v1/positions/${acmeId}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada Recruiter", title: "Recruiter", linkedinUrl: "https://example.com/in/ada", email: "ada@acme.test", notes: "ping Friday" }),
    });
    expect(created.status).toBe(201);
    const person = (await json<{ id: string; name: string; companyId: string }>(created)).data;
    expect(person.name).toBe("Ada Recruiter");

    const listed = await json<{ id: string; name: string }[]>(await app.request(`/api/v1/positions/${acmeSlug}/people`));
    expect(listed.ok).toBe(true);
    expect(listed.data.map((p) => p.name)).toEqual(["Ada Recruiter"]);

    const other = await json<{ id: string }[]>(await app.request(`/api/v1/positions/${zetaId}/people`));
    expect(other.data).toEqual([]);

    const stolen = await app.request(`/api/v1/positions/${zetaId}/people/${person.id}`, { method: "DELETE" });
    expect(stolen.status).toBe(404);

    const missingName = await app.request(`/api/v1/positions/${acmeId}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No name" }),
    });
    expect(missingName.status).toBe(400);

    const gone = await app.request(`/api/v1/positions/${acmeId}/people/${person.id}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    const empty = await json<unknown[]>(await app.request(`/api/v1/positions/${acmeId}/people`));
    expect(empty.data).toEqual([]);
  });

  it("interview CRUD lands on Today upcoming", async () => {
    const when = new Date(Date.now() + 86_400_000).toISOString();
    const created = await app.request(`/api/v1/positions/${acmeId}/interviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "hiring_manager", scheduledAt: when, notes: "loop" }),
    });
    expect(created.status).toBe(201);
    const row = (await json<{ id: string; stage: string; status: string; scheduledAt: string }>(created)).data;
    expect(row.stage).toBe("hiring_manager");
    expect(row.status).toBe("pending");

    const listed = await json<{ id: string }[]>(await app.request(`/api/v1/positions/${acmeId}/interviews`));
    expect(listed.data).toHaveLength(1);

    const today = await json<{ upcoming: { id: string; stage: string; slug: string }[] }>(await app.request("/api/v1/today"));
    expect(today.data.upcoming.some((u) => u.id === row.id && u.stage === "hiring_manager" && u.slug === acmeSlug)).toBe(true);

    const patched = await app.request(`/api/v1/positions/${acmeId}/interviews/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(patched.status).toBe(200);
    expect((await json<{ status: string }>(patched)).data.status).toBe("completed");

    const after = await json<{ upcoming: { id: string }[] }>(await app.request("/api/v1/today"));
    expect(after.data.upcoming.some((u) => u.id === row.id)).toBe(false);

    const badStatus = await app.request(`/api/v1/positions/${acmeId}/interviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "nope" }),
    });
    expect(badStatus.status).toBe(400);

    const gone = await app.request(`/api/v1/positions/${acmeId}/interviews/${row.id}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    const empty = await json<unknown[]>(await app.request(`/api/v1/positions/${acmeId}/interviews`));
    expect(empty.data).toEqual([]);
  });

  it("stores a transcript on an interview round", async () => {
    const created = await app.request(`/api/v1/positions/${acmeId}/interviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stage: "screen",
        title: "TA screen",
        interviewerName: "Ryan",
        outcome: "advanced",
        status: "completed",
        transcriptMarkdown: "Ryan: hello\nAlex: hi",
        skipBrief: true,
      }),
    });
    expect(created.status).toBe(201);
    const row = (await json<{ id: string; outcome: string; transcriptMarkdown: string; briefJobId: string | null }>(created)).data;
    expect(row.outcome).toBe("advanced");
    expect(row.transcriptMarkdown).toContain("Ryan:");
    expect(row.briefJobId).toBeNull();
    const one = await json<{ interviewerName: string }>(await app.request(`/api/v1/positions/${acmeId}/interviews/${row.id}`));
    expect(one.data.interviewerName).toBe("Ryan");
  });

  it("today funnel counts last 30d by status and applied this week", async () => {
    const { getDb, positions } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const now = Date.now();
    await db.update(positions).set({ status: "review", firstSeenAt: new Date(now - 5 * 86_400_000) }).where(eq(positions.id, acmeId));
    await db
      .update(positions)
      .set({
        status: "applied",
        firstSeenAt: new Date(now - 40 * 86_400_000),
        appliedAt: new Date(now - 2 * 86_400_000),
      })
      .where(eq(positions.id, zetaId));

    const today = await json<{
      counts: { last30d: Record<string, number>; appliedThisWeek: number; byStatus: Record<string, number> };
    }>(await app.request("/api/v1/today"));
    expect(today.data.counts.last30d.review).toBe(1);
    expect(today.data.counts.last30d.applied).toBe(0);
    expect(today.data.counts.appliedThisWeek).toBe(1);
    expect(today.data.counts.byStatus.review).toBeGreaterThanOrEqual(1);
  });

  it("retries failed llm ops via POST /settings/llm/retry", async () => {
    const { getDb, llmRuns, id } = await import("@job-scout/db");
    const db = await getDb();
    await db.insert(llmRuns).values({
      id: id("run"),
      operation: "triage",
      model: "m",
      positionId: acmeId,
      status: "error",
      error: "quota",
    });
    const res = await app.request("/api/v1/settings/llm/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours: 24, scope: "failed" }),
    });
    expect(res.status).toBe(202);
    const body = await json<{ enqueued: number; items: { positionId: string; operation: string }[] }>(res);
    expect(body.ok).toBe(true);
    expect(body.data.items.some((i) => i.positionId === acmeId && i.operation === "triage")).toBe(true);
  });
});
