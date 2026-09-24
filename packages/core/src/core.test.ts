import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { AtsJob } from "@job-scout/ats";

const dataDir = path.join(process.cwd(), ".data", "pglite-core-test");

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
    postedAt: "2026-06-10T14:21:01.277+00:00",
    departments: ["Engineering", "Infrastructure"],
    ...over,
  };
}

describe("core on pglite", () => {
  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.PGLITE_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    const { bootstrap } = await import("./bootstrap.js");
    await bootstrap({ seedBoards: true });
  });
  afterAll(async () => {
    const { closeDb } = await import("@job-scout/db");
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("seeds settings, profile and boards", async () => {
    const { getSettings } = await import("./settings.js");
    const { getProfile } = await import("./profile.js");
    const { listBoards } = await import("./radar.js");
    const s = await getSettings({ fresh: true });
    expect(s.gate.titleInclude).toEqual(["platform engineer", "sre", "devops engineer"]);
    // Public installs begin without an operator-specific brief.
    expect((await getProfile()).scoutBrief).toBe("");
    expect((await listBoards({})).length).toBeGreaterThan(10);
    const { updateSettings } = await import("./settings.js");
    const { bootstrap } = await import("./bootstrap.js");
    await updateSettings({ gate: { titleInclude: ["java"] } });
    await bootstrap({ seedBoards: false });
    expect((await getSettings({ fresh: true })).gate.titleInclude).toEqual(["java"]);
    await updateSettings({ gate: { titleInclude: ["platform engineer", "sre", "devops engineer"] } });
  });

  it("creates a position, ignores unchanged snapshots, writes one closed revision", async () => {
    const { upsertFromJob, applySnapshot, getPositionDetail, listPositions } = await import("./positions.js");
    const { position, created } = await upsertFromJob(job(), { source: "test" });
    expect(created).toBe(true);
    expect(position.status).toBe("triaged");
    expect(position.geoClass).toBe("brazil_friendly");

    const same = await applySnapshot({ positionId: position.id, job: job() });
    expect(same.changed).toBe(false);

    const comp = await applySnapshot({ positionId: position.id, job: job({ salaryRaw: "$160,000 - $200,000" }) });
    expect(comp.changed).toBe(true);
    expect(comp.revision).toBe(2);

    const closed1 = await applySnapshot({ positionId: position.id, job: job({ listingStatus: "closed", descriptionText: "" }) });
    expect(closed1.changed).toBe(true);
    const closed2 = await applySnapshot({ positionId: position.id, job: job({ listingStatus: "closed", descriptionText: "" }) });
    expect(closed2.changed).toBe(false);

    const detail = await getPositionDetail(position.slug);
    expect(detail?.revisions.length).toBe(3);
    expect(detail?.listingStatus).toBe("closed");
    expect(detail?.jd?.descriptionText).toContain("Kubernetes");
    expect(detail?.locationRaw).toBe("Remote - LATAM");
    expect(detail?.postedAt).toBe("2026-06-10T14:21:01.277+00:00");
    expect(detail?.departments).toEqual(["Engineering", "Infrastructure"]);

    expect(detail?.status).toBe("archived");
    expect(detail?.archiveReason).toBe("listing_closed");
    expect((await listPositions({ actionable: "true" })).total).toBe(0);
    const list = await listPositions({ pageSize: "10", includeArchived: "true" });
    expect(list.total).toBe(1);
    expect(list.items[0]?.company.name).toBe("Acme");
    expect(list.items[0]?.locationRaw).toBe("Remote - LATAM");
    expect("metadata" in (list.items[0] as object)).toBe(false);
  });

  it("dedupes and claims jobs atomically", async () => {
    const { enqueueJob, claimNextJob, completeJob, requeueStale } = await import("./jobs.js");
    const a = await enqueueJob("triage", { positionId: "p1" }, { dedupeKey: "triage:p1" });
    const b = await enqueueJob("triage", { positionId: "p1" }, { dedupeKey: "triage:p1" });
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
    const claimed = await claimNextJob(["triage"]);
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe("running");
    expect(await claimNextJob(["triage"])).toBeNull();
    await completeJob(a.id, { ok: true });
    expect(await requeueStale()).toBe(0);
  });

  it("updates settings with deep merge and validation", async () => {
    const { updateSettings, getSettings } = await import("./settings.js");
    const s = await updateSettings({ llm: { operations: { triage: { model: "gpt-x", dailyCap: 10 } } }, gate: { maxPostingAgeDays: 7 } });
    expect(s.llm.operations.triage?.model).toBe("gpt-x");
    expect(s.llm.operations.evaluate?.enabled).toBe(true);
    expect(s.gate.maxPostingAgeDays).toBe(7);
    expect(s.gate.titleInclude).toEqual(["platform engineer", "sre", "devops engineer"]);
    expect((await getSettings({ fresh: true })).gate.maxPostingAgeDays).toBe(7);
    await expect(updateSettings({ triage: { passThreshold: 9 } })).rejects.toThrow();
  });

  it("defaults llm fallback to grok-4.6 and returns it from gateOperation", async () => {
    const { getSettings, updateSettings } = await import("./settings.js");
    const { gateOperation } = await import("./llm.js");
    const { coreEnv } = await import("./env.js");
    expect((await getSettings({ fresh: true })).llm.fallbackModel).toBe("grok-4.6");
    coreEnv.openaiApiKey = "k";
    await updateSettings({ llm: { fallbackModel: "grok-4.6", operations: { evaluate: { model: "codex", enabled: true } } } });
    const cfg = await gateOperation("evaluate");
    expect(cfg.model).toBe("codex");
    expect(cfg.fallbackModel).toBe("grok-4.6");
    await updateSettings({ llm: { fallbackModel: "" } });
    expect((await gateOperation("evaluate")).fallbackModel).toBeUndefined();
  });

  it("gates LLM operations before calling out", async () => {
    const { gateOperation, LlmGateError } = await import("./llm.js");
    process.env.OPENAI_API_KEY = "";
    const { coreEnv } = await import("./env.js");
    coreEnv.openaiApiKey = "";
    await expect(gateOperation("triage")).rejects.toBeInstanceOf(LlmGateError);
    coreEnv.openaiApiKey = "k";
    const { updateSettings } = await import("./settings.js");
    await updateSettings({ llm: { operations: { evaluate: { model: "" } } } });
    await expect(gateOperation("evaluate")).rejects.toMatchObject({ code: "no_model" });
    await updateSettings({ llm: { operations: { evaluate: { model: "m", enabled: false } } } });
    await expect(gateOperation("evaluate")).rejects.toMatchObject({ code: "disabled" });
  });

  it("writes workplace on an unchanged snapshot when ATS workplaceType arrives later", async () => {
    const { upsertFromJob, applySnapshot, getPosition } = await import("./positions.js");
    const j = job({
      jobId: "late-wp",
      externalIdentity: "greenhouse:acme:late-wp",
      url: "https://boards.greenhouse.io/acme/jobs/late-wp",
      title: "Staff SRE",
      locationRaw: "Acme",
      company: "Acme",
    });
    const { position } = await upsertFromJob(j, { source: "test", companyName: "Acme" });
    expect(position.workplace).toBe("unknown");
    await applySnapshot({ positionId: position.id, job: { ...j, workplaceType: "Remote", isRemote: true } });
    const again = await getPosition(position.id);
    expect(again?.workplace).toBe("remote");
    expect(again?.geoClass).toBe("ambiguous_remote");
  });

  it("does not infer worldwide eligibility from company-name location plus Remote", async () => {
    const { upsertFromJob } = await import("./positions.js");
    const { position } = await upsertFromJob(
      job({
        jobId: "ll1",
        externalIdentity: "ashby:lightning:ll1",
        company: "Lightning Labs",
        title: "Platform Engineer (Remote)",
        locationRaw: "Lightning Labs",
        workplaceType: "Remote",
        isRemote: true,
        url: "https://jobs.ashbyhq.com/lightning/ll1",
      }),
      { source: "test", companyName: "Lightning Labs" },
    );
    expect(position.workplace).toBe("remote");
    expect(position.geoClass).toBe("ambiguous_remote");
  });

  it("runs retention without error", async () => {
    const { runRetention } = await import("./retention.js");
    const r = await runRetention();
    expect(r).toHaveProperty("jobs");
  });

  it("revives an archived position on operator intake and queues evaluate after a PASS triage", async () => {
    const { upsertFromJob, archivePosition } = await import("./positions.js");
    const { followUpIntake } = await import("./scan.js");
    const { claimNextJob, completeJob } = await import("./jobs.js");
    const { getDb, positions } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");

    const j = job({
      jobId: "rev1",
      externalIdentity: "greenhouse:acme:rev1",
      url: "https://boards.greenhouse.io/acme/jobs/rev1",
      title: "Staff SRE",
    });
    const { position } = await upsertFromJob(j, { source: "test" });
    await archivePosition(position.id, "v1-bulk-import: unknown/Explore");
    const db = await getDb();
    await db
      .update(positions)
      .set({
        triageScore: 4.9,
        triageVerdict: "pass",
        triagedAt: new Date(),
        triageJson: { score: 4.9, verdict: "pass", oneLiner: "fit" },
      })
      .where(eq(positions.id, position.id));

    const again = await upsertFromJob(j, { source: "manual", reviveArchived: true, status: "triaged" });
    expect(again.created).toBe(false);
    expect(again.revived).toBe(true);
    expect(again.position.status).toBe("triaged");
    expect(again.position.archiveReason).toBeNull();

    const follow = await followUpIntake(again.position, { created: false, revived: true });
    expect(follow.triageJobId).toBeNull();
    const claimed = await claimNextJob(["evaluate"]);
    expect(claimed?.payload).toMatchObject({ positionId: position.id, auto: true });
    if (claimed) await completeJob(claimed.id, { ok: true });
  });

  it("does not queue triage when no model key is configured", async () => {
    const { followUpIntake } = await import("./scan.js");
    const { upsertFromJob } = await import("./positions.js");
    const { coreEnv } = await import("./env.js");
    const { getDb, jobs } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const prev = coreEnv.openaiApiKey;
    coreEnv.openaiApiKey = "";
    try {
      const { position } = await upsertFromJob(
        job({
          jobId: "nokey",
          externalIdentity: "greenhouse:acme:nokey",
          url: "https://boards.greenhouse.io/acme/jobs/nokey",
          title: "Platform Engineer",
        }),
        { source: "test" },
      );
      const follow = await followUpIntake(position, { created: true, revived: false });
      expect(follow.triageJobId).toBeNull();
      const db = await getDb();
      const mine = await db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.type, "triage"));
      expect(mine.some((r) => (r.payload as { positionId?: string }).positionId === position.id)).toBe(false);
    } finally {
      coreEnv.openaiApiKey = prev;
    }
  });

  it("does not revive archived positions on a board-scan upsert", async () => {
    const { upsertFromJob, archivePosition } = await import("./positions.js");
    const j = job({
      jobId: "scan1",
      externalIdentity: "greenhouse:acme:scan1",
      url: "https://boards.greenhouse.io/acme/jobs/scan1",
      title: "Platform Engineer",
    });
    const { position } = await upsertFromJob(j, { source: "scan:greenhouse" });
    await archivePosition(position.id, "v1-bulk-import: unknown/Explore");
    const again = await upsertFromJob(j, { source: "scan:greenhouse" });
    expect(again.revived).toBe(false);
    expect(again.position.status).toBe("archived");
    expect(again.position.archiveReason).toContain("v1-bulk-import");
  });

  it("rechecks stored discovery when the gate starts allowing java titles", async () => {
    const { regateRecentDiscovery } = await import("./scan.js");
    const { updateSettings } = await import("./settings.js");
    const { getDb, discoveryFeed, jobs, id } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const rowId = id("df");
    await db.insert(discoveryFeed).values({
      id: rowId,
      externalIdentity: "greenhouse:acme:java-regate",
      company: "Acme",
      title: "Senior Java Engineer",
      url: "https://boards.greenhouse.io/acme/jobs/java-regate",
      locationRaw: "Remote",
      lane: "filtered",
      gateReason: "title_no_include",
      observedAt: new Date(),
    });
    await updateSettings({
      gate: {
        titleInclude: ["java", "software engineer"],
        titleExclude: ["manager"],
        geoAllow: ["remote"],
        geoBlock: [],
        maxPostingAgeDays: 0,
        allowUnknownGeo: true,
      },
    });
    const result = await regateRecentDiscovery();
    expect(result.nowPassed).toBeGreaterThanOrEqual(1);
    const row = (await db.select().from(discoveryFeed).where(eq(discoveryFeed.id, rowId)))[0];
    expect(row?.lane).toBe("passed");
    const queued = await db.select({ payload: jobs.payload, priority: jobs.priority }).from(jobs).where(eq(jobs.type, "scan_url"));
    const mine = queued.find((r) => (r.payload as { url?: string }).url?.includes("java-regate"));
    expect(mine).toBeTruthy();
    expect(mine?.priority).toBeGreaterThan(120);
  });

  it("uses target roles as the title gate and rechecks a stored java listing", async () => {
    const { titleIncludesFromRoles, syncGateFromTargetRoles } = await import("./profile.js");
    const { gateListing } = await import("@job-scout/shared");
    const { getSettings } = await import("./settings.js");
    const { getDb, discoveryFeed, id } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    expect(titleIncludesFromRoles([" Java Engineer ", "java engineer", "SRE", "a"])).toEqual(["java engineer", "java", "sre"]);
    const includes = titleIncludesFromRoles(["Java Engineer", "Software Engineer"]);
    const gate = { titleInclude: includes, titleExclude: [], geoAllow: ["remote"], geoBlock: [], maxPostingAgeDays: 0, allowUnknownGeo: true };
    expect(gateListing({ title: "Senior Java Developer", locationRaw: "Remote" }, gate).pass).toBe(true);
    expect(gateListing({ title: "Senior Software Engineer", locationRaw: "Remote" }, gate).pass).toBe(true);
    expect(gateListing({ title: "JavaScript Engineer", locationRaw: "Remote" }, gate).pass).toBe(false);
    const db = await getDb();
    const rowId = id("df");
    await db.insert(discoveryFeed).values({
      id: rowId,
      externalIdentity: "greenhouse:acme:role-sync",
      company: "Acme",
      title: "Senior Java Engineer",
      url: "https://boards.greenhouse.io/acme/jobs/role-sync",
      locationRaw: "Remote",
      lane: "filtered",
      gateReason: "title_no_include",
      observedAt: new Date(),
    });
    const synced = await syncGateFromTargetRoles(["Java Engineer"]);
    expect(synced?.titleInclude).toEqual(["java engineer", "java"]);
    expect((await getSettings({ fresh: true })).gate.titleInclude).toEqual(["java engineer", "java"]);
    const row = (await db.select().from(discoveryFeed).where(eq(discoveryFeed.id, rowId)))[0];
    expect(row?.lane).toBe("passed");
  });

  it("archives untouched scan filings whose titles miss the new gate", async () => {
    const { regateRecentDiscovery } = await import("./scan.js");
    const { updateSettings } = await import("./settings.js");
    const { upsertFromJob, getPosition, patchPosition } = await import("./positions.js");
    const { getDb, discoveryFeed, id } = await import("@job-scout/db");
    const db = await getDb();
    const drop = await upsertFromJob(job({
      jobId: "drop-sre",
      externalIdentity: "greenhouse:acme:drop-sre",
      url: "https://boards.greenhouse.io/acme/jobs/drop-sre",
      title: "Site Reliability Engineer",
    }), { source: "scan:greenhouse" });
    const keep = await upsertFromJob(job({
      jobId: "keep-java",
      externalIdentity: "greenhouse:acme:keep-java",
      url: "https://boards.greenhouse.io/acme/jobs/keep-java",
      title: "Senior Java Developer",
    }), { source: "scan:greenhouse" });
    const manual = await upsertFromJob(job({
      jobId: "manual-sre",
      externalIdentity: "greenhouse:acme:manual-sre",
      url: "https://boards.greenhouse.io/acme/jobs/manual-sre",
      title: "Site Reliability Engineer",
    }), { source: "manual" });
    const noted = await upsertFromJob(job({
      jobId: "noted-sre",
      externalIdentity: "greenhouse:acme:noted-sre",
      url: "https://boards.greenhouse.io/acme/jobs/noted-sre",
      title: "Site Reliability Engineer",
    }), { source: "scan:greenhouse" });
    await patchPosition(noted.position.id, { notes: "look later" });
    const review = await upsertFromJob(job({
      jobId: "review-sre",
      externalIdentity: "greenhouse:acme:review-sre",
      url: "https://boards.greenhouse.io/acme/jobs/review-sre",
      title: "Staff Site Reliability Engineer",
    }), { source: "scan:greenhouse", status: "review" });
    const observedAt = new Date();
    await db.insert(discoveryFeed).values([
      { id: id("df"), externalIdentity: "greenhouse:acme:drop-sre", company: "Acme", title: "Site Reliability Engineer", url: drop.position.primaryUrl, locationRaw: "Remote", lane: "passed", positionId: drop.position.id, observedAt },
      { id: id("df"), externalIdentity: "greenhouse:acme:keep-java", company: "Acme", title: "Senior Java Developer", url: keep.position.primaryUrl, locationRaw: "Remote", lane: "passed", positionId: keep.position.id, observedAt },
      { id: id("df"), externalIdentity: "greenhouse:acme:manual-sre", company: "Acme", title: "Site Reliability Engineer", url: manual.position.primaryUrl, locationRaw: "Remote", lane: "passed", positionId: manual.position.id, observedAt },
      { id: id("df"), externalIdentity: "greenhouse:acme:noted-sre", company: "Acme", title: "Site Reliability Engineer", url: noted.position.primaryUrl, locationRaw: "Remote", lane: "filtered", gateReason: "title_no_include", positionId: noted.position.id, observedAt },
      { id: id("df"), externalIdentity: "greenhouse:acme:review-sre", company: "Acme", title: "Staff Site Reliability Engineer", url: review.position.primaryUrl, locationRaw: "Remote", lane: "passed", positionId: review.position.id, observedAt },
    ]);
    await updateSettings({
      gate: {
        titleInclude: ["java"],
        titleExclude: ["manager"],
        geoAllow: ["remote"],
        geoBlock: [],
        maxPostingAgeDays: 0,
        allowUnknownGeo: true,
      },
    });
    const result = await regateRecentDiscovery();
    expect(result.withdrawn).toBe(1);
    const dropped = await getPosition(drop.position.id);
    expect(dropped?.status).toBe("archived");
    expect(dropped?.archiveReason).toBe("left the title gate (title_no_include)");
    expect((await getPosition(keep.position.id))?.status).toBe("triaged");
    expect((await getPosition(manual.position.id))?.status).toBe("triaged");
    expect((await getPosition(noted.position.id))?.status).toBe("triaged");
    expect((await getPosition(review.position.id))?.status).toBe("review");
    expect((await regateRecentDiscovery()).withdrawn).toBe(0);
  });

  it("archives an untouched office filing and keeps a remote one", async () => {
    const { regateRecentDiscovery, repairOfficeDiscoveryFilings } = await import("./scan.js");
    const { updateSettings } = await import("./settings.js");
    const { upsertFromJob, getPosition } = await import("./positions.js");
    const { getDb, discoveryFeed, id } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    const office = await upsertFromJob(job({
      jobId: "office-spain",
      externalIdentity: "greenhouse:elastic:office-spain",
      url: "https://boards.greenhouse.io/elastic/jobs/office-spain",
      title: "Senior Software Engineer",
      locationRaw: "Spain",
    }), { source: "scan:greenhouse" });
    const remote = await upsertFromJob(job({
      jobId: "remote-spain",
      externalIdentity: "ashby:clickhouse:remote-spain",
      url: "https://jobs.ashbyhq.com/clickhouse/remote-spain",
      title: "Senior Software Engineer",
      locationRaw: "Spain",
      workplaceType: "Remote",
      isRemote: true,
    }), { source: "scan:ashby" });
    const pasted = await upsertFromJob(job({
      jobId: "manual-spain",
      externalIdentity: "greenhouse:elastic:manual-spain",
      url: "https://boards.greenhouse.io/elastic/jobs/manual-spain",
      title: "Senior Software Engineer",
      locationRaw: "Spain",
    }), { source: "manual" });
    const observedAt = new Date();
    await db.insert(discoveryFeed).values([
      { id: id("df"), externalIdentity: "greenhouse:elastic:office-spain", company: "Elastic", title: office.position.title, url: office.position.primaryUrl, locationRaw: "Spain", lane: "passed", positionId: office.position.id, observedAt },
      { id: id("df"), externalIdentity: "ashby:clickhouse:remote-spain", company: "ClickHouse", title: remote.position.title, url: remote.position.primaryUrl, locationRaw: "Spain", lane: "passed", positionId: remote.position.id, observedAt },
      { id: id("df"), externalIdentity: "greenhouse:elastic:manual-spain", company: "Elastic", title: pasted.position.title, url: pasted.position.primaryUrl, locationRaw: "Spain", lane: "passed", positionId: pasted.position.id, observedAt },
    ]);
    await updateSettings({
      gate: {
        titleInclude: ["software engineer"],
        titleExclude: [],
        geoAllow: ["remote"],
        geoBlock: ["onsite", "hybrid"],
        maxPostingAgeDays: 0,
        allowUnknownGeo: true,
      },
    });
    const result = await regateRecentDiscovery();
    expect(result.withdrawn).toBeGreaterThanOrEqual(1);
    expect((await getPosition(office.position.id))?.status).toBe("archived");
    expect((await getPosition(office.position.id))?.archiveReason).toBe("left the location gate (geo_block:onsite)");
    const officeFeed = (await db.select().from(discoveryFeed).where(eq(discoveryFeed.positionId, office.position.id)))[0];
    expect(officeFeed?.lane).toBe("filtered");
    expect(officeFeed?.gateReason).toBe("geo_block:onsite");
    expect((await getPosition(remote.position.id))?.status).toBe("triaged");
    expect((await getPosition(pasted.position.id))?.status).toBe("triaged");
    const repaired = await repairOfficeDiscoveryFilings();
    expect(repaired.withdrawn).toBeGreaterThanOrEqual(1);
    expect((await getPosition(pasted.position.id))?.status).toBe("archived");
    expect((await getPosition(remote.position.id))?.status).toBe("triaged");
  });

  it("repairs discovery promotions that were stored as manual and now miss the title gate", async () => {
    const { repairMisstampedDiscoveryFilings, regateRecentDiscovery } = await import("./scan.js");
    const { updateSettings } = await import("./settings.js");
    const { upsertFromJob, getPosition, patchPosition } = await import("./positions.js");
    const { getDb, discoveryFeed, id } = await import("@job-scout/db");
    const db = await getDb();
    await updateSettings({
      gate: {
        titleInclude: ["software engineer"],
        titleExclude: ["junior", "early career"],
        geoAllow: ["remote"],
        geoBlock: [],
        maxPostingAgeDays: 0,
        allowUnknownGeo: true,
      },
    });
    const stuck = await upsertFromJob(job({
      jobId: "early-stuck",
      externalIdentity: "greenhouse:stripe:early-stuck",
      url: "https://boards.greenhouse.io/stripe/jobs/early-stuck",
      title: "Software Engineer, Early Career — Immediate Start",
    }), { source: "manual" });
    const noted = await upsertFromJob(job({
      jobId: "early-noted",
      externalIdentity: "greenhouse:stripe:early-noted",
      url: "https://boards.greenhouse.io/stripe/jobs/early-noted",
      title: "Software Engineer, Early Career — Immediate Start",
    }), { source: "manual" });
    await patchPosition(noted.position.id, { notes: "pasted on purpose" });
    const observedAt = new Date();
    await db.insert(discoveryFeed).values([
      { id: id("df"), externalIdentity: "greenhouse:stripe:early-stuck", company: "Stripe", title: stuck.position.title, url: stuck.position.primaryUrl, locationRaw: "Remote", lane: "filtered", gateReason: "title_exclude:early career", positionId: stuck.position.id, observedAt },
      { id: id("df"), externalIdentity: "greenhouse:stripe:early-noted", company: "Stripe", title: noted.position.title, url: noted.position.primaryUrl, locationRaw: "Remote", lane: "filtered", gateReason: "title_exclude:early career", positionId: noted.position.id, observedAt },
    ]);
    const repaired = await repairMisstampedDiscoveryFilings();
    expect(repaired.withdrawn).toBeGreaterThanOrEqual(1);
    expect((await getPosition(stuck.position.id))?.status).toBe("archived");
    expect((await getPosition(stuck.position.id))?.archiveReason).toBe("left the title gate (title_exclude:early career)");
    expect((await getPosition(noted.position.id))?.status).toBe("triaged");
    expect((await regateRecentDiscovery()).withdrawn).toBe(0);
    expect((await getPosition(noted.position.id))?.status).toBe("triaged");
  });

  it("returns one company when the same name is created together", async () => {
    const { resolveCompanyForName } = await import("./companies.js");
    const name = `Parallel Labs ${Date.now()}`;
    const rows = await Promise.all(Array.from({ length: 8 }, () => resolveCompanyForName(name)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
    expect(rows[0]?.slug).toBe(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
  });

  it("classifies a duplicate company slug as a unique violation", async () => {
    const { getDb, companies, id } = await import("@job-scout/db");
    const db = await getDb();
    const slug = `dup-${Date.now()}`;
    await db.insert(companies).values({ id: id("co"), slug, name: "Dup", metadata: {} });
    try {
      await db.insert(companies).values({ id: id("co"), slug, name: "Dup", metadata: {} });
      expect.fail("duplicate slug should throw");
    } catch (err) {
      const seen = new Set<unknown>();
      let unique = false;
      let cur: unknown = err;
      while (cur && typeof cur === "object" && !seen.has(cur)) {
        seen.add(cur);
        const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
        if (o.code === "23505" || (typeof o.message === "string" && /duplicate key|unique constraint|already exists/i.test(o.message))) unique = true;
        cur = o.cause;
      }
      expect(unique).toBe(true);
    }
  });

  it("listDiscovery attaches an existing position by ATS identity when positionId is missing", async () => {
    const { upsertFromJob } = await import("./positions.js");
    const { listDiscovery } = await import("./radar.js");
    const { getDb, discoveryFeed, id } = await import("@job-scout/db");
    const j = job({
      jobId: "disc1",
      externalIdentity: "greenhouse:acme:disc1",
      url: "https://boards.greenhouse.io/acme/jobs/disc1",
      title: "Senior DevOps Engineer",
    });
    const { position } = await upsertFromJob(j, { source: "test" });
    const db = await getDb();
    await db.insert(discoveryFeed).values({
      id: id("df"),
      externalIdentity: j.externalIdentity,
      company: "Acme",
      title: j.title,
      url: j.url,
      lane: "filtered",
      gateReason: "geo_unknown",
      observedAt: new Date(),
    });
    const r = await listDiscovery({ q: "Acme", hours: "24" });
    const row = r.items.find((x) => x.externalIdentity === j.externalIdentity);
    expect(row?.positionSlug).toBe(position.slug);
    expect(row?.positionStatus).toBe("triaged");
  });

  it("upserts application questions without clobbering a human answer", async () => {
    const { upsertFromJob } = await import("./positions.js");
    const { harvestQuestions, parseApplicationQuestions } = await import("./questions.js");
    const { getDb, applicationQuestions } = await import("@job-scout/db");
    const { eq, and } = await import("drizzle-orm");
    const { position } = await upsertFromJob(
      job({ jobId: "q1", externalIdentity: "greenhouse:acme:q1", url: "https://boards.greenhouse.io/acme/jobs/q1" }),
      { source: "test" },
    );
    const prompts = [
      { question: "Name", required: true, inputType: "text" },
      { question: "Why Lightning Labs?", required: true, inputType: "textarea" },
    ];
    await harvestQuestions(position.id, prompts);
    await harvestQuestions(position.id, [
      ...prompts,
      { question: "Name", required: false, inputType: "text" },
      { question: "name", required: false, inputType: "text" },
    ]);
    const db = await getDb();
    const rows = await db.select().from(applicationQuestions).where(eq(applicationQuestions.positionId, position.id));
    expect(rows).toHaveLength(2);
    const name = rows.find((r) => r.question === "Name")!;
    await db.update(applicationQuestions).set({ answer: "Alex", status: "answered" }).where(eq(applicationQuestions.id, name.id));
    await harvestQuestions(position.id, prompts);
    const again = (
      await db
        .select()
        .from(applicationQuestions)
        .where(and(eq(applicationQuestions.positionId, position.id), eq(applicationQuestions.question, "Name")))
    )[0];
    expect(again?.answer).toBe("Alex");
    expect(again?.status).toBe("answered");
    const { listQuestions, harvestFromJob } = await import("./questions.js");
    await harvestQuestions(position.id, [prompts[0]!]);
    expect((await listQuestions(position.id)).map(q => q.question)).toEqual(["Name"]);
    await harvestFromJob(position.id, { ...job(), questionPrompts: [], formHarvestError: "unavailable" });
    expect(await listQuestions(position.id)).toHaveLength(1);
    await harvestFromJob(position.id, { ...job(), questionPrompts: [] });
    expect(await listQuestions(position.id)).toHaveLength(0);
    const { getPositionDetail } = await import("./positions.js");
    expect((await getPositionDetail(position.id))?.questions.open).toBe(0);
    await harvestQuestions(position.id, prompts);
    expect(await listQuestions(position.id)).toHaveLength(2);
    expect((await listQuestions(position.id)).find(q => q.question === "Name")?.answer).toBe("Alex");
    const parsed = parseApplicationQuestions(
      `<form><label>Name*</label><label>Email*</label><label>What is your experience with bitcoin and lightning?*</label><label>Autofill from resume</label></form>`,
    );
    expect(parsed.map((p) => p.question)).toEqual(["Name", "Email", "What is your experience with bitcoin and lightning?"]);
    expect(parsed[0]?.required).toBe(true);
  });

  it("moves only triaged to review after evaluate", async () => {
    const { nextStatusAfterEvaluate } = await import("./evaluate.js");
    expect(nextStatusAfterEvaluate("archived")).toBe("archived");
    expect(nextStatusAfterEvaluate("triaged")).toBe("review");
    expect(nextStatusAfterEvaluate("applied")).toBe("applied");
    expect(nextStatusAfterEvaluate("skip")).toBe("skip");
  });

  it("gates listing_classify and form_answers on enable and daily cap", async () => {
    const { gateOperation, LlmGateError } = await import("./llm.js");
    const { updateSettings } = await import("./settings.js");
    const { getDb, llmRuns, id } = await import("@job-scout/db");
    const { coreEnv } = await import("./env.js");
    coreEnv.openaiApiKey = "k";
    await updateSettings({ llm: { operations: { listing_classify: { model: "m", enabled: false, dailyCap: 10 } } } });
    await expect(gateOperation("listing_classify")).rejects.toMatchObject({ code: "disabled" });
    await updateSettings({ llm: { operations: { form_answers: { model: "m", enabled: true, dailyCap: 1 } } } });
    const db = await getDb();
    await db.insert(llmRuns).values({ id: id("run"), operation: "form_answers", model: "m", status: "ok" });
    await expect(gateOperation("form_answers")).rejects.toBeInstanceOf(LlmGateError);
    await expect(gateOperation("form_answers")).rejects.toMatchObject({ code: "cap_reached" });
    await updateSettings({
      llm: { operations: { listing_classify: { model: "m", enabled: true, dailyCap: 10 }, form_answers: { model: "m", enabled: true, dailyCap: 40 } } },
    });
  });

  it("list endpoints honor sort=", async () => {
    const { upsertFromJob, listPositions } = await import("./positions.js");
    const { listDiscovery, listBoards } = await import("./radar.js");
    const { listCompanies } = await import("./companies.js");
    const { listQuestions, harvestQuestions } = await import("./questions.js");
    const { getDb, discoveryFeed, id } = await import("@job-scout/db");

    const a = await upsertFromJob(
      job({
        jobId: "sort-a",
        externalIdentity: "greenhouse:acme:sort-a",
        url: "https://boards.greenhouse.io/acme/jobs/sort-a",
        title: "AAA Platform",
        company: "Acme",
      }),
      { source: "test", companyName: "Acme" },
    );
    const z = await upsertFromJob(
      job({
        jobId: "sort-z",
        externalIdentity: "greenhouse:zeta:sort-z",
        url: "https://boards.greenhouse.io/zeta/jobs/sort-z",
        title: "ZZZ Platform",
        company: "Zeta",
        locationRaw: "Remote - LATAM",
      }),
      { source: "test", companyName: "Zeta" },
    );
    const db = await getDb();
    await db.update((await import("@job-scout/db")).positions).set({ triageScore: 1 }).where((await import("drizzle-orm")).eq((await import("@job-scout/db")).positions.id, a.position.id));
    await db.update((await import("@job-scout/db")).positions).set({ triageScore: 5 }).where((await import("drizzle-orm")).eq((await import("@job-scout/db")).positions.id, z.position.id));

    const dashed = await upsertFromJob(
      job({
        jobId: "search-eu",
        externalIdentity: "greenhouse:alpaca:search-eu",
        url: "https://boards.greenhouse.io/alpaca/jobs/search-eu",
        title: "Senior Software Engineer New Markets - EU",
        company: "Alpaca",
        locationRaw: "Remote - EMEA",
      }),
      { source: "test", companyName: "Alpaca" },
    );
    const byPhrase = await listPositions({ q: "New Markets EU", includeArchived: "true", pageSize: "50" });
    expect(byPhrase.items.some((r) => r.id === dashed.position.id)).toBe(true);
    const byPlace = await listPositions({ q: "EMEA", includeArchived: "true", pageSize: "50" });
    expect(byPlace.items.some((r) => r.id === dashed.position.id)).toBe(true);
    const miss = await listPositions({ q: "New Markets APAC", includeArchived: "true", pageSize: "50" });
    expect(miss.items.some((r) => r.id === dashed.position.id)).toBe(false);

    const copied = await upsertFromJob(
      job({
        jobId: "copies",
        externalIdentity: "ashby:clickhouse:copies",
        url: "https://jobs.ashbyhq.com/clickhouse/copies-1",
        title: "Senior Backend Engineer - ClickStack",
        company: "ClickHouse",
      }),
      { source: "test", companyName: "ClickHouse" },
    );
    const now = new Date();
    await db.insert(discoveryFeed).values([
      { id: id("df"), externalIdentity: "ashby:clickhouse:copies-1", company: "ClickHouse", title: "Senior Backend Engineer - ClickStack", url: "https://jobs.ashbyhq.com/clickhouse/copies-1", lane: "passed", positionId: copied.position.id, observedAt: new Date(now.getTime() - 1000) },
      { id: id("df"), externalIdentity: "ashby:clickhouse:copies-2", company: "ClickHouse", title: "Senior Backend Engineer - ClickStack", url: "https://jobs.ashbyhq.com/clickhouse/copies-2", lane: "passed", positionId: copied.position.id, observedAt: now },
    ]);
    const copies = await listDiscovery({ q: "ClickStack", hours: "24" });
    const copyHits = copies.items.filter((item) => item.positionId === copied.position.id);
    expect(copyHits).toHaveLength(1);
    expect(copyHits[0]?.copies).toBe(2);

    const byCompany = await listPositions({ q: "Platform", sort: "company_asc", pageSize: "50" });
    const acmeIdx = byCompany.items.findIndex((r) => r.id === a.position.id);
    const zetaIdx = byCompany.items.findIndex((r) => r.id === z.position.id);
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(zetaIdx).toBeGreaterThan(acmeIdx);

    const byScore = await listPositions({ q: "Platform", sort: "score_desc", pageSize: "50" });
    expect(byScore.items[0]?.id).toBe(z.position.id);

    const { positions } = await import("@job-scout/db");
    await db.update(positions).set({ lastChangedAt: new Date(Date.now() - 86_400_000) }).where((await import("drizzle-orm")).eq(positions.id, a.position.id));
    await db.update(positions).set({ lastChangedAt: new Date() }).where((await import("drizzle-orm")).eq(positions.id, z.position.id));
    const byChanged = await listPositions({ q: "Platform", sort: "last_changed_desc", pageSize: "50" });
    expect(byChanged.items[0]?.id).toBe(z.position.id);

    await db.insert(discoveryFeed).values([
      { id: id("df"), externalIdentity: "greenhouse:acme:sort-a", company: "Acme", title: "AAA Platform", url: a.position.primaryUrl, lane: "passed", observedAt: new Date() },
      { id: id("df"), externalIdentity: "greenhouse:zeta:sort-z", company: "Zeta", title: "ZZZ Platform", url: z.position.primaryUrl, lane: "passed", observedAt: new Date() },
    ]);
    const disc = await listDiscovery({ q: "Platform", hours: "24", sort: "title_desc" });
    expect(disc.items[0]?.title).toBe("ZZZ Platform");

    const boards = await listBoards({ sort: "company_desc" });
    expect(boards.length).toBeGreaterThan(1);
    expect(boards[0]!.company.localeCompare(boards[boards.length - 1]!.company)).toBeGreaterThanOrEqual(0);

    const companies = await listCompanies({ q: "e", sort: "name_asc", withPositions: "true" });
    const names = companies.items.map((c) => c.name);
    const sorted = [...names].sort((x, y) => x.localeCompare(y));
    expect(names).toEqual(sorted);

    await harvestQuestions(a.position.id, [
      { question: "Zebra", required: false, inputType: "text" },
      { question: "Alpha", required: false, inputType: "text" },
    ]);
    const qs = await listQuestions(a.position.id, { sort: "question_asc" });
    expect(qs.map((r) => r.question)).toEqual(["Alpha", "Zebra"]);
  });

  it("enqueues listing_classify when location was discarded as the company name", async () => {
    const { upsertFromJob } = await import("./positions.js");
    const { updateSettings } = await import("./settings.js");
    await updateSettings({ llm: { operations: { listing_classify: { model: "m", enabled: true } } } });
    const { position } = await upsertFromJob(
      job({
        jobId: "ll-class",
        externalIdentity: "ashby:lightning:ll-class",
        company: "Lightning Labs",
        title: "Platform Engineer (Remote)",
        locationRaw: "Lightning Labs",
        workplaceType: "Remote",
        isRemote: true,
        url: "https://jobs.ashbyhq.com/lightning/ll-class",
      }),
      { source: "test", companyName: "Lightning Labs" },
    );
    const { getDb: gdb, jobs } = await import("@job-scout/db");
    const { and, eq, sql } = await import("drizzle-orm");
    const queued = await gdb().then((db) =>
      db
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, "listing_classify"), sql`${jobs.payload}->>'positionId' = ${position.id}`)),
    );
    expect(queued.length).toBeGreaterThan(0);
  });

  it("getPositionDetail includes a questions summary", async () => {
    const { upsertFromJob, getPositionDetail } = await import("./positions.js");
    const { harvestQuestions, patchQuestion } = await import("./questions.js");
    const { position } = await upsertFromJob(
      job({ jobId: "qs-sum", externalIdentity: "greenhouse:acme:qs-sum", url: "https://boards.greenhouse.io/acme/jobs/qs-sum" }),
      { source: "test" },
    );
    const harvested = await harvestQuestions(position.id, [
      { question: "Name", required: true, inputType: "text" },
      { question: "Why us?", required: true, inputType: "textarea" },
    ]);
    expect(harvested.upserted).toBeGreaterThan(0);
    const { listQuestions } = await import("./questions.js");
    const rows = await listQuestions(position.id);
    await patchQuestion(rows[0]!.id, { answer: "Alex" });
    const detail = await getPositionDetail(position.id);
    expect(detail?.questions).toEqual({ open: 2, drafted: 1, total: 2 });
  });

  it("stores a form harvest error on the position and backfill skips archived", async () => {
    const { upsertFromJob, archivePosition } = await import("./positions.js");
    const { harvestFromJob } = await import("./questions.js");
    const { backfillListingFacts } = await import("./listing-classify.js");
    const { getDb, positions } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const { position } = await upsertFromJob(
      job({
        jobId: "ash-err",
        externalIdentity: "ashby:ll:ash-err",
        company: "Lightning Labs",
        url: "https://jobs.ashbyhq.com/lightning/ash-err",
        locationRaw: "Lightning Labs",
        workplaceType: "Remote",
        isRemote: true,
        questions: [],
        formHarvestError: "could not fetch form",
      }),
      { source: "test", companyName: "Lightning Labs" },
    );
    await harvestFromJob(position.id, {
      ...job({ jobId: "ash-err" }),
      provider: "ashby",
      questions: [],
      formHarvestError: "could not fetch form",
    });
    const detail = (await import("./positions.js")).getPositionDetail;
    const d = await detail(position.id);
    expect((d?.metadata as { forms?: { harvestError?: string } } | null)?.forms?.harvestError).toBe("could not fetch form");

    const archived = await upsertFromJob(
      job({
        jobId: "bf-arch",
        externalIdentity: "greenhouse:acme:bf-arch",
        url: "https://boards.greenhouse.io/acme/jobs/bf-arch",
        locationRaw: "US only",
      }),
      { source: "test" },
    );
    await archivePosition(archived.position.id, "test");
    const db = await getDb();
    await db.update(positions).set({ workplace: "unknown", geoClass: "unknown" }).where(eq(positions.id, archived.position.id));
    const r = await backfillListingFacts({ force: true });
    expect(r.archivedSkipped).toBeGreaterThanOrEqual(1);
    const again = (await db.select().from(positions).where(eq(positions.id, archived.position.id)))[0];
    expect(again?.workplace).toBe("unknown");
  });

  it("enqueues Remote OK list_api scans without hitting the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network forbidden in enqueue test");
      }),
    );
    try {
      const { enqueueDueBoardScans } = await import("./scan.js");
      const { getDb, boardSources, jobs } = await import("@job-scout/db");
      const { and, eq } = await import("drizzle-orm");
      const db = await getDb();
      const remote = (
        await db
          .select()
          .from(boardSources)
          .where(and(eq(boardSources.token, "remoteok"), eq(boardSources.provider, "remoteok")))
      )[0];
      expect(remote).toBeTruthy();
      expect(remote?.capability).toBe("list_api");
      expect(remote?.enabled).toBe(true);
      expect(remote?.sourceKind).toBe("market");
      const { due, enqueued } = await enqueueDueBoardScans({ all: true, limit: 100 });
      expect(due).toBeGreaterThan(0);
      expect(enqueued).toBeGreaterThan(0);
      const queued = await db.select().from(jobs).where(eq(jobs.type, "board_scan"));
      const wwr = (
        await db
          .select()
          .from(boardSources)
          .where(and(eq(boardSources.token, "weworkremotely"), eq(boardSources.provider, "market")))
      )[0];
      expect(wwr).toBeTruthy();
      expect(wwr?.capability).toBe("list_api");
      expect(wwr?.enabled).toBe(true);
      const remotive = (
        await db
          .select()
          .from(boardSources)
          .where(and(eq(boardSources.token, "remotive"), eq(boardSources.provider, "market")))
      )[0];
      expect(remotive).toBeTruthy();
      expect(remotive?.capability).toBe("list_api");
      expect(remotive?.enabled).toBe(true);
      expect(queued.some((j) => (j.payload as { boardId?: string }).boardId === remote?.id)).toBe(true);
      expect(queued.some((j) => (j.payload as { boardId?: string }).boardId === wwr?.id)).toBe(true);
      expect(queued.some((j) => (j.payload as { boardId?: string }).boardId === remotive?.id)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("enqueues never-scanned Remote OK boards first without hitting the network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network forbidden in enqueue test");
      }),
    );
    try {
      const { enqueueDueBoardScans } = await import("./scan.js");
      const { getDb, boardSources, jobs } = await import("@job-scout/db");
      const { and, eq } = await import("drizzle-orm");
      const db = await getDb();
      const remote = (
        await db
          .select()
          .from(boardSources)
          .where(and(eq(boardSources.token, "remoteok"), eq(boardSources.provider, "remoteok")))
      )[0];
      expect(remote).toBeTruthy();
      await db.delete(jobs).where(eq(jobs.type, "board_scan"));
      const scanned = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await db.update(boardSources).set({ lastScannedAt: scanned });
      await db
        .update(boardSources)
        .set({ lastScannedAt: null })
        .where(and(eq(boardSources.provider, "remoteok"), eq(boardSources.token, "remoteok")));
      const { due, enqueued } = await enqueueDueBoardScans({ limit: 1 });
      expect(due).toBe(1);
      expect(enqueued).toBe(1);
      const queued = await db.select().from(jobs).where(eq(jobs.type, "board_scan"));
      expect(queued).toHaveLength(1);
      expect((queued[0]?.payload as { boardId?: string }).boardId).toBe(remote?.id);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("marks unresolved employers explicitly and excludes them from decisions", async () => {
    const { upsertFromJob } = await import("./positions.js");
    const { position } = await upsertFromJob(
      {
        provider: "linkedin",
        title: "Mystery role",
        url: "https://www.linkedin.com/jobs/view/42424242",
        listingStatus: "open",
        descriptionText: "A JD that arrived without a company.",
      },
      { source: "clip" },
    );
    expect(position.company.name).toBe("__unresolved__");
    const { listPositions } = await import("./positions.js");
    expect((await listPositions({ actionable: "true", company: "unresolved" })).total).toBe(0);
  });

  it("intakeClipSnapshot stores a LinkedIn-shaped JD without fetching", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network forbidden in clip snapshot test");
      }),
    );
    try {
      const { intakeClipSnapshot } = await import("./scan.js");
      const { getPositionDetail } = await import("./positions.js");
      const jd = "Own the Kubernetes control plane. Terraform, Argo CD, and on-call for Stripe's edge.";
      const r = await intakeClipSnapshot({
        url: "https://www.linkedin.com/jobs/view/4123456789/",
        title: "Staff SRE at Stripe | LinkedIn",
        text: jd,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(r.created).toBe(true);
      expect(r.position.title).toBe("Staff SRE");
      expect(r.position.company.name).toBe("Stripe");
      expect(r.position.source).toBe("clip");
      expect(r.position.atsProvider).toBe("linkedin");
      const detail = await getPositionDetail(r.position.id);
      expect(detail?.jd?.descriptionText).toContain("Kubernetes control plane");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("retries the latest failed llm op and skips a later success", async () => {
    const { upsertFromJob } = await import("./positions.js");
    const { retryFailedLlm } = await import("./llm.js");
    const { getDb, llmRuns, id, jobs } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const { position } = await upsertFromJob(
      job({
        jobId: "retry-1",
        externalIdentity: "greenhouse:acme:retry-1",
        url: "https://boards.greenhouse.io/acme/jobs/retry-1",
      }),
      { source: "test" },
    );
    const db = await getDb();
    const older = new Date(Date.now() - 120_000);
    const mid = new Date(Date.now() - 60_000);
    await db.insert(llmRuns).values([
      { id: id("run"), operation: "triage", model: "m", positionId: position.id, status: "error", error: "quota", createdAt: mid },
      { id: id("run"), operation: "evaluate", model: "m", positionId: position.id, status: "error", error: "quota", createdAt: older },
      { id: id("run"), operation: "evaluate", model: "m", positionId: position.id, status: "ok", createdAt: mid },
      { id: id("run"), operation: "company_research", model: "m", positionId: position.id, status: "error", error: "quota", createdAt: mid },
    ]);
    const r = await retryFailedLlm({ hours: 24, scope: "failed" });
    expect(r.items.some((i) => i.operation === "triage" && i.positionId === position.id && !i.deduped)).toBe(true);
    expect(r.items.some((i) => i.operation === "evaluate")).toBe(false);
    expect(r.items.some((i) => i.operation === "company_research" && i.positionId === position.id)).toBe(true);
    const queued = await db.select().from(jobs).where(eq(jobs.type, "triage"));
    const triage = queued.find((j) => (j.payload as { positionId?: string }).positionId === position.id);
    expect(triage?.payload).toMatchObject({ positionId: position.id, force: true });
    const research = (await db.select().from(jobs).where(eq(jobs.type, "company_research"))).find(
      (j) => (j.payload as { positionId?: string }).positionId === position.id,
    );
    expect(research?.payload).toMatchObject({ positionId: position.id, companyId: position.companyId });
    expect((research?.payload as { force?: boolean }).force).toBeUndefined();
  });

  it("does not retry archived positions; failed_and_missing enqueues untriaged opens", async () => {
    const { upsertFromJob, archivePosition } = await import("./positions.js");
    const { retryFailedLlm } = await import("./llm.js");
    const { getDb, llmRuns, id } = await import("@job-scout/db");
    const dead = await upsertFromJob(
      job({
        jobId: "retry-arch",
        externalIdentity: "greenhouse:acme:retry-arch",
        url: "https://boards.greenhouse.io/acme/jobs/retry-arch",
      }),
      { source: "test" },
    );
    const open = await upsertFromJob(
      job({
        jobId: "retry-miss",
        externalIdentity: "greenhouse:acme:retry-miss",
        url: "https://boards.greenhouse.io/acme/jobs/retry-miss",
        title: "Staff SRE",
      }),
      { source: "test" },
    );
    await archivePosition(dead.position.id, "test", "test");
    const db = await getDb();
    await db.insert(llmRuns).values({
      id: id("run"),
      operation: "triage",
      model: "m",
      positionId: dead.position.id,
      status: "error",
      error: "quota",
    });
    const failedOnly = await retryFailedLlm({ hours: 24, scope: "failed" });
    expect(failedOnly.items.some((i) => i.positionId === dead.position.id)).toBe(false);
    const r = await retryFailedLlm({ hours: 24, scope: "failed_and_missing", limit: 500 });
    expect(r.items.some((i) => i.positionId === open.position.id && i.operation === "triage")).toBe(true);
    expect(r.items.some((i) => i.positionId === dead.position.id)).toBe(false);
  });

  it("lists a company only while it has an open role", async () => {
    const { upsertFromJob, archivePosition } = await import("./positions.js");
    const { listCompanies } = await import("./companies.js");
    const row = await upsertFromJob(
      job({
        jobId: "archived-only",
        externalIdentity: "greenhouse:shelved:archived-only",
        url: "https://boards.greenhouse.io/shelved/jobs/archived-only",
        title: "Software Engineer",
        company: "Shelved Co",
      }),
      { source: "test", companyName: "Shelved Co" },
    );
    await archivePosition(row.position.id, "test", "test");
    expect((await listCompanies({ q: "Shelved", withPositions: "true" })).items).toHaveLength(0);
    const all = await listCompanies({ q: "Shelved" });
    expect(all.items).toHaveLength(1);
    expect(all.items[0]?.positionsOpen).toBe(0);
    expect(all.items[0]?.positionsTotal).toBe(1);
  });

  it("home geo filter keeps a US place and drops a foreign one", async () => {
    const { upsertFromJob, listPositions } = await import("./positions.js");
    const { updateProfile } = await import("./profile.js");
    await updateProfile({ location: "Austin, TX" });
    const us = await upsertFromJob(
      job({
        jobId: "home-us",
        externalIdentity: "greenhouse:acme:home-us",
        url: "https://boards.greenhouse.io/acme/jobs/home-us",
        title: "Backend Engineer",
        company: "Acme",
        locationRaw: "Remote - USA",
      }),
      { source: "test", companyName: "Acme" },
    );
    const poland = await upsertFromJob(
      job({
        jobId: "home-pl",
        externalIdentity: "greenhouse:acme:home-pl",
        url: "https://boards.greenhouse.io/acme/jobs/home-pl",
        title: "Backend Engineer Poland",
        company: "Acme",
        locationRaw: "Remote, Poland",
      }),
      { source: "test", companyName: "Acme" },
    );
    const { getDb, positions } = await import("@job-scout/db");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    await db.update(positions).set({ geoClass: "hard_geo" }).where(eq(positions.id, us.position.id));
    await db.update(positions).set({ geoClass: "hard_geo" }).where(eq(positions.id, poland.position.id));
    const home = await listPositions({ geoClass: "home", includeArchived: "true", pageSize: "200" });
    const ids = home.items.map((row) => row.id);
    expect(ids).toContain(us.position.id);
    expect(ids).not.toContain(poland.position.id);
  });

  it("refuses a notification test when WhatsApp is not configured", async () => {
    const { sendTestNotify } = await import("./notify.js");
    const result = await sendTestNotify("desk");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });
});
