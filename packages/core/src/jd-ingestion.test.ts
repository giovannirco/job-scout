import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { closeDb, evaluations, getDb, id, jdRevisions, jobs, positions } from "@job-scout/db";
import { AtsFetchError, type AtsJob } from "@job-scout/ats";
import { bootstrap } from "./bootstrap.js";
import { coreEnv } from "./env.js";
import { updateSettings } from "./settings.js";
import { applySnapshot, getPosition, listPositions, patchPosition, refreshPosition, upsertFromJob } from "./positions.js";
import { BoardIndexError, boardRetitled, followUpIntake, intakeUrl } from "./scan.js";
import { runTriage } from "./triage.js";
import { runEvaluate } from "./evaluate.js";
import { repairStaleTitleSlugs, slugForRetitle } from "./slug-repair.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-jd-ingestion-"));

/** Synthetic JD long enough to score. */
const JD = [
  "Acme Example runs a payments platform on Kubernetes across three regions.",
  "You will own Terraform modules, CI/CD pipelines, observability with Prometheus and Grafana, and the on-call rotation.",
  "We expect five years operating production infrastructure, strong Linux and networking skills, and clear written communication.",
].join("\n\n");

const role = (slug: string, over: Partial<AtsJob> = {}): AtsJob => ({
  provider: "workable",
  boardToken: "acme-example",
  jobId: slug.toUpperCase().padEnd(10, "X"),
  externalIdentity: `workable:acme-example:${slug.toUpperCase().padEnd(10, "X")}`,
  company: "Acme Example",
  title: "Senior Platform Engineer",
  url: `https://apply.workable.com/acme-example/j/${slug.toUpperCase().padEnd(10, "X")}/`,
  locationRaw: "Remote",
  descriptionText: JD,
  listingStatus: "open",
  ...over,
});

async function jobsFor(type: string, positionId: string) {
  const db = await getDb();
  return (await db.select().from(jobs).where(eq(jobs.type, type as never))).filter((j) => (j.payload as { positionId?: string }).positionId === positionId);
}

async function revisionsOf(positionId: string) {
  const db = await getDb();
  return db.select().from(jdRevisions).where(eq(jdRevisions.positionId, positionId)).orderBy(desc(jdRevisions.revision));
}

describe("JD ingestion gaps (isolated PGlite)", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
    await updateSettings({ jev: { enabled: true, triage: "observe" } });
  });
  beforeEach(async () => {
    const db = await getDb();
    await db.delete(jobs);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  describe("1. title-only JD", () => {
    it("is stored but flagged needsJd; triage, evaluate and the fit check do not run", async () => {
      const { position } = await upsertFromJob(role("t1", { descriptionText: "Senior Platform Engineer" }), { status: "triaged" });
      expect(position.metadata?.needsJd).toMatchObject({ reason: "title_only", words: 0 });
      expect(await jobsFor("jev_check", position.id)).toHaveLength(0);
      expect(await followUpIntake(position, { created: true, revived: false })).toEqual({ triageJobId: null });
      expect(await runTriage(position.id)).toMatchObject({ skipped: true, reason: "needs_jd" });
      expect(await runEvaluate(position.id)).toMatchObject({ skipped: true, reason: "needs_jd" });
      const lane = await listPositions({ needsJd: "true", status: "triaged,review" });
      expect(lane.items.map((p) => p.id)).toContain(position.id);
    });

    it("when the real JD arrives: needsJd clears, earlier evaluations are superseded, triage and the fit check are re-queued", async () => {
      const { position } = await upsertFromJob(role("t2", { descriptionText: "Senior Platform Engineer Apply now" }), { status: "triaged" });
      const db = await getDb();
      const evalId = id("ev");
      await db.insert(evaluations).values({ id: evalId, positionId: position.id, companyId: position.companyId, kind: "evaluate", json: { score: 2.5, headline: "empty listing" } });
      const r = await applySnapshot({ positionId: position.id, job: role("t2") });
      expect(r).toMatchObject({ changed: true, revision: 2 });
      const after = (await getPosition(position.id))!;
      expect(after.metadata?.needsJd).toBeUndefined();
      const ev = (await db.select().from(evaluations).where(eq(evaluations.id, evalId)))[0]!;
      expect(ev.json).toMatchObject({ superseded: { reason: "jd_arrived", byRevision: 2 } });
      const triage = await jobsFor("triage", position.id);
      expect(triage).toHaveLength(1);
      expect(triage[0]!.payload).toMatchObject({ force: true, reason: "jd_arrived" });
      expect((await jobsFor("jev_check", position.id)).map((j) => j.payload?.revision)).toEqual([2]);
    });

    it("a JD that shrinks back to the title sets needsJd again without a new paid review", async () => {
      const { position } = await upsertFromJob(role("t3"), { status: "applied" });
      await applySnapshot({ positionId: position.id, job: role("t3", { descriptionText: "Senior Platform Engineer" }) });
      expect((await getPosition(position.id))!.metadata?.needsJd).toMatchObject({ reason: "title_only" });
      expect(await jobsFor("jd_review", position.id)).toHaveLength(0);
    });
  });

  describe("2. title changes", () => {
    it("an ATS retitle updates the title, records a title revision and reslugs; the old slug still resolves", async () => {
      const { position } = await upsertFromJob(role("r1"), { status: "triaged" });
      const oldSlug = position.slug;
      const r = await applySnapshot({ positionId: position.id, job: role("r1", { title: "Staff Platform Engineer" }) });
      expect(r).toMatchObject({ changed: true, changeKind: "title" });
      const after = (await getPosition(position.id))!;
      expect(after.title).toBe("Staff Platform Engineer");
      expect(after.slug).not.toBe(oldSlug);
      expect(after.slug).toContain("staff-platform-engineer");
      expect(after.metadata?.previousSlugs).toContain(oldSlug);
      expect((await getPosition(oldSlug))?.id).toBe(position.id);
      expect((await revisionsOf(position.id))[0]).toMatchObject({ title: "Staff Platform Engineer", changeKind: "title" });
      expect((await jobsFor("triage", position.id))[0]?.payload).toMatchObject({ force: true, reason: "retitled" });
    });

    it("a title set by hand survives an ATS retitle; the revision still records the posting's title", async () => {
      const { position } = await upsertFromJob(role("r2"), { status: "triaged" });
      await patchPosition(position.id, { title: "Platform Engineer (Payments)" }, "operator");
      const pinned = (await getPosition(position.id))!;
      expect(pinned.metadata?.titleOverride).toMatchObject({ title: "Platform Engineer (Payments)", actor: "operator" });
      await applySnapshot({ positionId: position.id, job: role("r2", { title: "Lead Platform Engineer" }) });
      const after = (await getPosition(position.id))!;
      expect(after.title).toBe("Platform Engineer (Payments)");
      expect(after.slug).toBe(pinned.slug);
      expect((await revisionsOf(position.id))[0]!.title).toBe("Lead Platform Engineer");
      expect(boardRetitled(after, "Lead Platform Engineer")).toBe(false);
    });

    it("a slug built from a bad first title follows the corrected title", async () => {
      const { position } = await upsertFromJob(role("r3", { title: "Engineering Team" }), { status: "triaged" });
      expect(position.slug).toContain("engineering-team");
      await applySnapshot({ positionId: position.id, job: role("r3", { title: "Senior Site Reliability Engineer" }) });
      const after = (await getPosition(position.id))!;
      expect(after.slug).toContain("senior-site-reliability-engineer");
      expect((await getPosition(position.slug))?.id).toBe(position.id);
    });

    it("a hand-picked slug never moves on a retitle", async () => {
      const { position } = await upsertFromJob(role("r4"), { status: "triaged" });
      const db = await getDb();
      await db.update(positions).set({ slug: "acme-example-payments-sre" }).where(eq(positions.id, position.id));
      await applySnapshot({ positionId: position.id, job: role("r4", { title: "Principal Platform Engineer" }) });
      expect((await getPosition(position.id))!.slug).toBe("acme-example-payments-sre");
    });

    it("repairStaleTitleSlugs reslugs rows whose title was fixed before reslugging existed", async () => {
      const { position } = await upsertFromJob(role("r5", { title: "Platform Team" }), { status: "triaged" });
      const db = await getDb();
      await db.update(positions).set({ title: "Database Reliability Engineer" }).where(eq(positions.id, position.id));
      const plan = await repairStaleTitleSlugs();
      expect(plan.positions.find((p) => p.id === position.id)).toMatchObject({ from: position.slug });
      await repairStaleTitleSlugs({ apply: true });
      const after = (await getPosition(position.id))!;
      expect(after.slug).toContain("database-reliability-engineer");
      expect((await getPosition(position.slug))?.id).toBe(position.id);
    });

    it("repairStaleTitleSlugs skips a row whose stored title is still a not-a-JD title", async () => {
      const { position } = await upsertFromJob(role("r6", { title: "Senior Platform Engineer" }), { status: "triaged" });
      const db = await getDb();
      await db.update(positions).set({ title: "Job Not Found" }).where(eq(positions.id, position.id));
      expect((await revisionsOf(position.id)).some((r) => r.title === "Senior Platform Engineer")).toBe(true);
      const plan = await repairStaleTitleSlugs();
      expect(plan.positions.find((p) => p.id === position.id)).toBeUndefined();
      await repairStaleTitleSlugs({ apply: true });
      expect((await getPosition(position.id))!.slug).toBe(position.slug);
    });

    it("slugForRetitle never derives a slug from a not-a-JD or shell title", () => {
      const pos = { id: "pos_000000000abcd", slug: "acme-example-engineering-team-abcd", title: "Engineering Team", companySlug: "acme-example" };
      expect(slugForRetitle(pos, "Job Not Found")).toBeNull();
      expect(slugForRetitle(pos, "Jobs")).toBeNull();
      expect(slugForRetitle(pos, "   ")).toBeNull();
      expect(slugForRetitle(pos, "Staff Platform Engineer")).toBe("acme-example-staff-platform-engineer-abcd");
    });

    it("boardRetitled: a real, different board title triggers a refetch; noise and closed rows do not", () => {
      const pos = { title: "Senior Platform Engineer", listingStatus: "open", metadata: {} };
      expect(boardRetitled(pos, "Staff Platform Engineer")).toBe(true);
      expect(boardRetitled(pos, "senior platform engineer ")).toBe(false);
      expect(boardRetitled(pos, "Jobs")).toBe(false);
      expect(boardRetitled({ ...pos, listingStatus: "closed" }, "Staff Platform Engineer")).toBe(false);
      // Only ATS boards are trusted: aggregator feeds rewrite titles ("Company: Title").
      expect(boardRetitled(pos, "Staff Platform Engineer", "ashby")).toBe(true);
      expect(boardRetitled(pos, "Acme Example: Senior Platform Engineer", "weworkremotely")).toBe(false);
    });
  });

  describe("3. fetch failure reasons", () => {
    const url = "https://careers.acme-example.com/jobs/platform-engineer-3";
    it("refresh_jd surfaces a network failure's cause and stores it in metadata.lastAtsFetch", async () => {
      const { position } = await upsertFromJob(role("f1", { provider: "other", boardToken: undefined, jobId: undefined, externalIdentity: undefined, url }), { status: "triaged" });
      vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }); }));
      const err = await refreshPosition(position.id, "mcp").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AtsFetchError);
      expect(err).toMatchObject({ reason: "network", causeCode: "ENOTFOUND" });
      const after = (await getPosition(position.id))!;
      expect(after.metadata?.lastAtsFetch).toMatchObject({ source: "mcp", error: { reason: "network", causeCode: "ENOTFOUND" } });
      expect(after.title).toBe("Senior Platform Engineer");
    });

    it("an HTTP 403 is recorded as blocked with its status", async () => {
      const blockedUrl = "https://careers.acme-example.com/jobs/platform-engineer-4";
      const { position } = await upsertFromJob(role("f2", { provider: "other", boardToken: undefined, jobId: undefined, externalIdentity: undefined, url: blockedUrl }), { status: "triaged" });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
      await expect(refreshPosition(position.id)).rejects.toMatchObject({ reason: "blocked", httpStatus: 403 });
      expect((await getPosition(position.id))!.metadata?.lastAtsFetch).toMatchObject({ error: { reason: "blocked", httpStatus: 403 } });
    });
  });

  describe("4. board / index pages at intake", () => {
    it("refuses an ATS board root without fetching and suggests adding the board", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const err = await intakeUrl("https://boards.greenhouse.io/acme-example").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoardIndexError);
      expect(err).toMatchObject({ code: "board_index", reason: "board_url", boardSuggestion: { provider: "greenhouse", token: "acme-example" } });
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(intakeUrl("https://www.acme-example.com/careers")).rejects.toMatchObject({ code: "board_index" });
    });

    it("refuses a page titled like a careers listing", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><title>Job openings | Acme Example</title></head><body><h1>Job openings</h1>${"<a href=/x>Role</a> ".repeat(40)}</body></html>`, { status: 200 })));
      const err = await intakeUrl("https://www.acme-example.com/about/team-and-roles").catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "board_index", reason: "board_title" });
      const db = await getDb();
      expect((await db.select().from(positions).where(eq(positions.primaryUrl, "https://www.acme-example.com/about/team-and-roles")))).toHaveLength(0);
    });
  });

  describe("5. JD churn", () => {
    it("whitespace, tracking params, date stamps and reordered blocks write no revision", async () => {
      const body = `${JD}\n\nApply: https://apply.workable.com/acme-example/j/C1XXXXXXXX/apply\n\nPosted 3 days ago`;
      const { position } = await upsertFromJob(role("c1", { descriptionText: body }), { status: "applied" });
      const [p1, p2, p3] = JD.split("\n\n");
      const cosmetic = `${p3}\n\n${p1}\n\n  ${p2}  \n\nApply: https://apply.workable.com/acme-example/j/C1XXXXXXXX/apply?utm_source=board&utm_medium=feed\n\nPosted 5 days ago`;
      const r = await applySnapshot({ positionId: position.id, job: role("c1", { descriptionText: cosmetic }) });
      expect(r).toMatchObject({ changed: false });
      expect(await revisionsOf(position.id)).toHaveLength(1);
      expect(await jobsFor("jd_review", position.id)).toHaveLength(0);
    });

    it("jd_review runs at most once per day for description edits; a title change still queues one", async () => {
      const { position } = await upsertFromJob(role("c2"), { status: "applied" });
      await applySnapshot({ positionId: position.id, job: role("c2", { descriptionText: `${JD}\n\nVisa sponsorship is not available.` }) });
      const first = await jobsFor("jd_review", position.id);
      expect(first).toHaveLength(1);
      const db = await getDb();
      await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, first[0]!.id));
      await applySnapshot({ positionId: position.id, job: role("c2", { descriptionText: `${JD}\n\nVisa sponsorship is not available. Contract role.` }) });
      expect(await jobsFor("jd_review", position.id)).toHaveLength(1);
      await applySnapshot({ positionId: position.id, job: role("c2", { title: "Staff Platform Engineer", descriptionText: `${JD}\n\nVisa sponsorship is not available. Contract role.` }) });
      expect(await jobsFor("jd_review", position.id)).toHaveLength(2);
      const revs = await revisionsOf(position.id);
      expect(revs[0]).toMatchObject({ changeKind: "title", material: true });
      expect(revs[1]).toMatchObject({ changeKind: "content", material: true });
    });

    it("an edit landing before the first check runs still gets a check (queued checks do not count)", async () => {
      const { position } = await upsertFromJob(role("c4"), { status: "triaged" });
      await applySnapshot({ positionId: position.id, job: role("c4", { descriptionText: `${JD}\n\nOn-site in Lisbon twice a month.` }) });
      expect((await jobsFor("jev_check", position.id)).map((j) => j.payload?.revision).sort()).toEqual([1, 2]);
    });

    it("a location that only gains detail is a non-material revision that still stores the new location", async () => {
      const { position } = await upsertFromJob(role("l1", { locationRaw: "Mexico City" }), { status: "applied" });
      const db = await getDb();
      await db.delete(jobs);
      const r = await applySnapshot({ positionId: position.id, job: role("l1", { locationRaw: "Mexico City, Mexico" }) });
      expect(r).toMatchObject({ changed: true, revision: 2 });
      const [rev] = await revisionsOf(position.id);
      expect(rev).toMatchObject({ revision: 2, changeKind: "noise_rebase", material: false, locationRaw: "Mexico City, Mexico" });
      expect(await jobsFor("jd_review", position.id)).toHaveLength(0);
      expect(await jobsFor("jev_check", position.id)).toHaveLength(0);
      expect((await getPosition(position.id))!.listingStatus).toBe("open");
    });

    it("a refined location that moves the geo class stays a material geo change", async () => {
      const { position } = await upsertFromJob(role("l2", { locationRaw: "Remote" }), { status: "applied" });
      const db = await getDb();
      await db.delete(jobs);
      await applySnapshot({ positionId: position.id, job: role("l2", { locationRaw: "Remote · Argentina · Brazil" }) });
      const [rev] = await revisionsOf(position.id);
      expect(rev).toMatchObject({ revision: 2, changeKind: "geo", material: true, locationRaw: "Remote · Argentina · Brazil" });
      expect((rev!.fieldDiffs as Array<{ path: string }>).map((d) => d.path)).toContain("geo_class");
      expect(await jobsFor("jd_review", position.id)).toHaveLength(1);
    });

    it("the fit check is rate-limited the same way; a location change bypasses the limit", async () => {
      const { position } = await upsertFromJob(role("c3"), { status: "triaged" });
      const first = await jobsFor("jev_check", position.id);
      expect(first.map((j) => j.payload?.revision)).toEqual([1]);
      const db = await getDb();
      await db.update(jobs).set({ status: "done" }).where(eq(jobs.id, first[0]!.id));
      await applySnapshot({ positionId: position.id, job: role("c3", { descriptionText: `${JD}\n\nHybrid two days a week.` }) });
      expect(await jobsFor("jev_check", position.id)).toHaveLength(1);
      await applySnapshot({ positionId: position.id, job: role("c3", { descriptionText: `${JD}\n\nHybrid two days a week.`, locationRaw: "Lisbon, Portugal" }) });
      expect((await jobsFor("jev_check", position.id)).map((j) => j.payload?.revision).sort()).toEqual([1, 3]);
    });
  });
});
