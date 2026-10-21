import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { approvals, closeDb, getDb, jobs, timelineEvents } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { afterEvaluate, afterTriage } from "./autopilot.js";
import { getPosition, patchPosition, upsertFromJob } from "./positions.js";
import { followUpIntake } from "./scan.js";
import { updateSettings } from "./settings.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-aggregator-"));

function aggregatorJob(slug: string, over: Partial<AtsJob> = {}): AtsJob {
  return {
    provider: "other",
    title: "Senior Platform Engineer",
    company: "Jobgether",
    url: `https://jobgether.com/offer/${slug}-senior-platform-engineer`,
    listingStatus: "open",
    descriptionText: "Operate Kubernetes and Terraform for a remote team.",
    ...over,
  };
}
const ld = (name: string) => `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Senior Platform Engineer", hiringOrganization: { name } })}</script></head></html>`;

describe("aggregator intake", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({
      notifications: { enabled: false },
      autopilot: { preset: "custom", triageNew: true, suggestStatus: true, evaluate: { mode: "all_pass" }, companyResearch: { mode: "off" }, materials: { mode: "off" } },
      jev: { enabled: false },
    });
  });
  beforeEach(async () => { await (await getDb()).delete(jobs); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("links an aggregator repost to the employer's existing filing instead of a new active position", async () => {
    const original = (await upsertFromJob({
      provider: "greenhouse", boardToken: "globexlabs", company: "Globex Labs", jobId: "701", externalIdentity: "greenhouse:globexlabs:701",
      title: "Senior Platform Engineer", url: "https://job-boards.greenhouse.io/globexlabs/jobs/701", listingStatus: "open",
      descriptionText: "Operate Kubernetes and Terraform.",
    }, { status: "review" })).position;
    await patchPosition(original.id, { status: "applied" });

    const res = await upsertFromJob(aggregatorJob("g1", { rawPayload: { htmlExcerpt: ld("Globex Labs") } }), { source: "manual" });
    expect(res.created).toBe(true);
    expect(res.position.company.name).toBe("Globex Labs");
    expect(res.position.status).toBe("archived");
    expect(res.position.archiveReason).toContain("aggregator_duplicate");
    expect(res.position.metadata).toMatchObject({ duplicateOfId: original.id, aggregator: { host: "jobgether.com", unresolved: false, employer: "Globex Labs", via: "json_ld", duplicateOfId: original.id } });

    const db = await getDb();
    const note = await db.select().from(timelineEvents).where(and(eq(timelineEvents.positionId, original.id), eq(timelineEvents.kind, "duplicate")));
    expect(note[0]?.title).toBe("Also listed on jobgether.com");
    expect(await followUpIntake(res.position, { created: true, revived: false })).toEqual({ triageJobId: null });
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect((await getPosition(original.id))?.status).toBe("applied");
  });

  it("holds an aggregator row with a hidden employer from auto-evaluation and apply suggestions", async () => {
    const res = await upsertFromJob(aggregatorJob("u1", { descriptionText: "This position is posted by Jobgether on behalf of a partner company. Operate Kubernetes." }), { source: "manual" });
    const pos = res.position;
    expect(pos.company.name).toBe("__unresolved__");
    expect(pos.status).toBe("triaged");
    expect(pos.metadata).toMatchObject({ aggregator: { host: "jobgether.com", unresolved: true, employer: null } });

    expect(await afterTriage({ positionId: pos.id, companyId: pos.companyId, score: 4.6, verdict: "pass", status: "triaged" })).toEqual({ autopilotSkipped: "aggregator_unresolved" });
    const db = await getDb();
    expect(await db.select().from(jobs).where(eq(jobs.type, "evaluate"))).toHaveLength(0);
    expect(await afterEvaluate({ positionId: pos.id, companyId: pos.companyId, evaluationId: "eval_synthetic", score: 4.5, verdict: "apply", headline: "Strong fit", status: "triaged" })).toEqual({ autopilotSkipped: "aggregator_unresolved" });
    expect(await db.select().from(approvals).where(eq(approvals.positionId, pos.id))).toHaveLength(0);
  });

  it("files a resolved aggregator role with no prior filing as a normal active position", async () => {
    const res = await upsertFromJob(aggregatorJob("n1", { title: "Staff Observability Engineer", rawPayload: { htmlExcerpt: "<title>Staff Observability Engineer at Initech | Jobgether</title>" } }), { source: "manual" });
    expect(res.position.company.name).toBe("Initech");
    expect(res.position.status).toBe("triaged");
    expect(res.position.metadata).toMatchObject({ aggregator: { host: "jobgether.com", unresolved: false, employer: "Initech", via: "title" } });
    expect(res.position.metadata).not.toHaveProperty("duplicateOfId");
    const auto = await afterTriage({ positionId: res.position.id, companyId: res.position.companyId, score: 4.6, verdict: "pass", status: "triaged" });
    expect(auto.evaluateJobId).toBeTruthy();
  });
});
