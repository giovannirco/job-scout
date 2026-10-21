import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { closeDb, evaluations, getDb, jdRevisions, jobs, positions, timelineEvents } from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { bootstrap } from "./bootstrap.js";
import { applySnapshot, getPosition, patchPosition, SOFT_404_CONFIRM_MS, stampCareerOps, upsertFromJob } from "./positions.js";
import { createApproval, resolveApproval } from "./autopilot.js";
import { saveMaterial } from "./materials.js";
import { coreEnv } from "./env.js";
import { planLastGoodRepair, repairToLastGoodRevision } from "./jd-repair.js";
import { careerOpsStampState, listMaterialsWithoutFiles, MaterialsMissingError, repairMaterialsWithoutFiles } from "./pipeline-integrity.js";

const dir = mkdtempSync(join(tmpdir(), "job-scout-jd-guards-"));
const JD = "Own the cloud platform: Kubernetes, Terraform, observability and on-call for payments. ".repeat(12);
/** Exact InHire no-JavaScript page text; tenant prefix is synthetic. */
const INHIRE_JS_WALL = "acmepay • • • … This website need Javascript. Please turn it on.";
const inhire = (slug: string, over: Partial<AtsJob> = {}): AtsJob => ({
  provider: "other",
  company: "Acme Pay",
  title: "Cloud Platform Engineer III",
  url: `https://acmepay.inhire.app/vagas/c0ffee00-abcd-4ef0-9abc-${slug.padStart(12, "f")}/cloud-platform-engineer-iii`,
  locationRaw: "Brasil",
  descriptionText: JD,
  listingStatus: "open",
  ...over,
});

async function counts(positionId: string) {
  const db = await getDb();
  const revs = await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, positionId));
  const jdChanges = await db.select().from(timelineEvents).where(and(eq(timelineEvents.positionId, positionId), eq(timelineEvents.kind, "jd_change")));
  const reviews = (await db.select().from(jobs).where(eq(jobs.type, "jd_review"))).filter((j) => (j.payload as { positionId?: string }).positionId === positionId);
  return { revisions: revs.length, jdChanges: jdChanges.length, jdReviews: reviews.length };
}

describe("JD snapshot guards and last-good repair (isolated PGlite)", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    coreEnv.openaiApiKey = "test-only";
    await bootstrap({ seedBoards: false });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(async () => { await closeDb(); rmSync(dir, { recursive: true, force: true }); });

  it("an InHire JS wall never writes a revision, jd_change or jd_review (JS-wall clobber case)", async () => {
    const { position } = await upsertFromJob(inhire("a1"), { status: "review" });
    const before = await counts(position.id);
    const r = await applySnapshot({ positionId: position.id, job: inhire("a1", { title: "acmepay", descriptionText: INHIRE_JS_WALL }) });
    expect(r).toMatchObject({ changed: false, rejected: expect.stringMatching(/^not_a_jd:js_wall/) });
    expect(await counts(position.id)).toEqual(before);
    const after = (await getPosition(position.id))!;
    expect(after.title).toBe("Cloud Platform Engineer III");
  });

  it("another company's posting is refused (cross-company clobber case)", async () => {
    const { position } = await upsertFromJob(inhire("b2", { title: "Site Reliability Engineer - Senior" }), { status: "interview" });
    const before = await counts(position.id);
    const r = await applySnapshot({ positionId: position.id, job: { provider: "other", company: "Globex Labs", title: "Senior DevOps Engineer", url: "https://weworkremotely.com/remote-jobs/globex-labs-senior-devops-engineer", locationRaw: "Worldwide (EST hours)", descriptionText: JD, listingStatus: "open" } });
    expect(r).toMatchObject({ changed: false, rejected: expect.stringMatching(/^identity_mismatch:/) });
    expect(await counts(position.id)).toEqual(before);
    expect((await getPosition(position.id))!.title).toBe("Site Reliability Engineer - Senior");
  });

  it("the JD is frozen at interview/offer; only an explicit force refresh rewrites it, a closure still applies", async () => {
    const { position } = await upsertFromJob(inhire("p15"), { status: "interview" });
    const before = await counts(position.id);
    const edited = inhire("p15", { title: "Cloud Platform Engineer IV", descriptionText: `${JD} Now also owns the data platform.` });
    const r = await applySnapshot({ positionId: position.id, job: edited, source: "watch" });
    expect(r).toMatchObject({ changed: false, rejected: "frozen:interview" });
    expect(await counts(position.id)).toEqual(before);
    expect((await getPosition(position.id))!.title).toBe("Cloud Platform Engineer III");
    // The same refusal on the next tick is not logged again.
    await applySnapshot({ positionId: position.id, job: edited, source: "scan" });
    const db = await getDb();
    const frozenEvents = (await db.select().from(timelineEvents).where(eq(timelineEvents.positionId, position.id))).filter((e) => e.title.includes("frozen:interview"));
    expect(frozenEvents).toHaveLength(1);
    const forced = await applySnapshot({ positionId: position.id, job: edited, source: "manual", force: true });
    expect(forced).toMatchObject({ changed: true });
    expect((await getPosition(position.id))!.title).toBe("Cloud Platform Engineer IV");
    // force never lifts the identity guard.
    const other = await applySnapshot({ positionId: position.id, job: { ...edited, company: "Globex Labs", url: "https://jobs.globex.test/sre-1" }, force: true });
    expect(other).toMatchObject({ rejected: expect.stringMatching(/^identity_mismatch:/) });
    await applySnapshot({ positionId: position.id, job: inhire("p15", { title: "", descriptionText: "", listingStatus: "closed" }), source: "watch" });
    expect((await getPosition(position.id))!.listingStatus).toBe("closed");
  });

  it("an automatic watch never rewrites a non-hot position with watchEnabled=false", async () => {
    const { position } = await upsertFromJob(inhire("q16"), { status: "triaged" });
    expect(position.watchEnabled).toBe(false);
    const edited = inhire("q16", { descriptionText: `${JD} Pager rotation is one week in six.` });
    const r = await applySnapshot({ positionId: position.id, job: edited, source: "watch" });
    expect(r).toMatchObject({ changed: false, rejected: "watch_disabled" });
    expect((await applySnapshot({ positionId: position.id, job: edited, source: "scan" })).changed).toBe(true);
  });

  it("upsert alias dedupe requires the same employer", async () => {
    const { position: a } = await upsertFromJob({ ...inhire("r17"), provider: "other", company: "Initech", url: "https://jobs.shared-board.test/openings/42?utm_source=feed" }, { status: "review" });
    const { position: b, created } = await upsertFromJob({ ...inhire("r17"), provider: "other", company: "Umbrella Analytics", url: "https://jobs.shared-board.test/openings/42" });
    expect(created).toBe(true);
    expect(b.id).not.toBe(a.id);
    const again = await upsertFromJob({ ...inhire("r17"), provider: "other", company: "Initech", url: "https://jobs.shared-board.test/openings/42/" });
    expect(again).toMatchObject({ created: false, position: { id: a.id } });
  });

  it("a Greenhouse URL with and without ?gh_jid= is one position", async () => {
    const gh = "https://job-boards.greenhouse.io/acmepay/jobs/4012345";
    const { position: a } = await upsertFromJob({ ...inhire("s18"), provider: "other", url: `${gh}?gh_jid=4012345` }, { status: "review" });
    const again = await upsertFromJob({ ...inhire("s18"), provider: "other", url: gh });
    expect(again).toMatchObject({ created: false, position: { id: a.id } });
  });

  /** Move the recorded first soft-404 observation back in time (the confirm window is SOFT_404_CONFIRM_MS). */
  async function ageSoftNotFound(positionId: string, ms = SOFT_404_CONFIRM_MS + 60_000) {
    const db = await getDb();
    const meta = { ...((await getPosition(positionId))!.metadata || {}) } as Record<string, unknown>;
    const last = { ...(meta.lastAtsFetch as Record<string, unknown>) };
    last.softNotFoundSince = new Date(Date.parse(String(last.softNotFoundSince)) - ms).toISOString();
    await db.update(positions).set({ metadata: { ...meta, lastAtsFetch: last } }).where(eq(positions.id, positionId));
  }
  const soft404 = (slug: string) => inhire(slug, { title: "Job Not Found", descriptionText: "Sorry, job not found." });

  it("a soft-404 page closes the listing only on a second, later observation and keeps the JD", async () => {
    const { position } = await upsertFromJob(inhire("c3"), { status: "review" });
    const first = await applySnapshot({ positionId: position.id, job: soft404("c3") });
    expect(first).toMatchObject({ changed: false, rejected: expect.stringMatching(/^not_a_jd:not_found/) });
    let after = (await getPosition(position.id))!;
    expect(after).toMatchObject({ listingStatus: "open", status: "review", title: "Cloud Platform Engineer III" });
    // A confirming fetch seconds later (scan + refresh_jd) is not enough.
    await applySnapshot({ positionId: position.id, job: soft404("c3") });
    expect((await getPosition(position.id))!).toMatchObject({ listingStatus: "open", status: "review" });
    await ageSoftNotFound(position.id);
    await applySnapshot({ positionId: position.id, job: soft404("c3") });
    after = (await getPosition(position.id))!;
    expect(after.listingStatus).toBe("closed");
    expect(after.status).toBe("archived");
    expect(after.title).toBe("Cloud Platform Engineer III");
  });

  it("a not-found title over a full-length JD body is refused but never closes", async () => {
    const { position } = await upsertFromJob(inhire("n14"), { status: "review" });
    const odd = inhire("n14", { title: "Page not found | Acme Pay" });
    await applySnapshot({ positionId: position.id, job: odd });
    await ageSoftNotFound(position.id);
    const r = await applySnapshot({ positionId: position.id, job: odd });
    expect(r).toMatchObject({ rejected: expect.stringMatching(/^not_a_jd:not_found:title/) });
    expect((await getPosition(position.id))!).toMatchObject({ listingStatus: "open", status: "review", title: "Cloud Platform Engineer III" });
  });

  it("a good fetch between soft-404s resets the streak", async () => {
    const { position } = await upsertFromJob(inhire("k11"), { status: "review" });
    await applySnapshot({ positionId: position.id, job: soft404("k11") });
    await ageSoftNotFound(position.id);
    await applySnapshot({ positionId: position.id, job: inhire("k11") });
    await applySnapshot({ positionId: position.id, job: soft404("k11") });
    expect((await getPosition(position.id))!).toMatchObject({ listingStatus: "open", status: "review" });
  });

  it("an HTTP-level closure (fetcher listingStatus closed) still closes at once", async () => {
    const { position } = await upsertFromJob(inhire("l12"), { status: "review" });
    await applySnapshot({ positionId: position.id, job: inhire("l12", { title: "", descriptionText: "", listingStatus: "closed" }) });
    expect((await getPosition(position.id))!).toMatchObject({ listingStatus: "closed", status: "archived", title: "Cloud Platform Engineer III" });
  });

  it("a real short JD that mentions a filled position is applied, never closed", async () => {
    const shortJd = "Frontend Engineer. Requires JavaScript, TypeScript and React. This position is no longer available? Ask us: we hire all year.";
    const { position } = await upsertFromJob(inhire("m13", { title: "Frontend Engineer", descriptionText: shortJd }), { status: "review" });
    const edited = `${shortJd} Remote in Brazil.`;
    for (let i = 0; i < 2; i++) {
      await applySnapshot({ positionId: position.id, job: inhire("m13", { title: "Frontend Engineer", descriptionText: edited }) });
      await ageSoftNotFound(position.id).catch(() => undefined);
    }
    const after = (await getPosition(position.id))!;
    expect(after).toMatchObject({ listingStatus: expect.not.stringMatching(/^closed$/), status: "review" });
  });

  it("last-good repair: dry-run plans, --apply restores, supersedes and queues", async () => {
    const { position } = await upsertFromJob(inhire("d4"), { status: "review" });
    const db = await getDb();
    // Seed a clobber the old code would have written, plus evaluations scored on it.
    const cutoff = new Date(Date.now() + 60_000);
    await db.insert(jdRevisions).values({ id: "jdr_bad_d4", positionId: position.id, revision: 2, observedAt: cutoff, contentHash: "bad", changeKind: "content", title: "Cloud Platform Engineer III", descriptionText: INHIRE_JS_WALL, source: "test" });
    await db.insert(evaluations).values([
      { id: "ev_old_d4", positionId: position.id, kind: "evaluate", json: { score: 4 }, createdAt: new Date(cutoff.getTime() - 3_600_000) },
      { id: "ev_bad_d4", positionId: position.id, kind: "evaluate", json: { score: 2.5 }, createdAt: new Date(cutoff.getTime() + 1_000) },
    ]);
    const preset = { positionId: position.id, before: cutoff.toISOString(), supersedeFrom: cutoff.toISOString() };
    const dry = await repairToLastGoodRevision(preset);
    expect(dry).toMatchObject({ dryRun: true, supersede: ["ev_bad_d4"], enqueue: ["jd_review", "triage"] });
    expect(dry.steps[0]).toMatchObject({ step: "restore_revision", detail: { fromRevision: 1, title: "Cloud Platform Engineer III" } });
    expect((await counts(position.id)).revisions).toBe(2);

    const applied = await repairToLastGoodRevision(preset, { apply: true });
    expect(applied.dryRun).toBe(false);
    const revs = await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, position.id));
    const repair = revs.find((r) => r.changeKind === "repair")!;
    expect(repair.revision).toBe(3);
    expect(repair.descriptionText).toBe(JD);
    const evs = await db.select().from(evaluations).where(eq(evaluations.positionId, position.id));
    expect(evs.find((e) => e.id === "ev_bad_d4")?.json).toMatchObject({ superseded: { reason: expect.any(String) } });
    expect(evs.find((e) => e.id === "ev_old_d4")?.json).not.toHaveProperty("superseded");
    const queued = (await db.select().from(jobs)).filter((j) => (j.payload as { positionId?: string }).positionId === position.id).map((j) => [j.type, (j.payload as { force?: boolean }).force ?? null]);
    expect(queued).toEqual(expect.arrayContaining([["jd_review", null], ["triage", true]]));
  });

  it("planner skips guard-failing and cross-company revisions and respects the window", () => {
    const t = (h: number) => new Date(Date.UTC(2026, 0, 1, h)).toISOString();
    const plan = planLastGoodRepair({
      position: { id: "pos_x", title: "SRE", status: "interview", listingStatus: "changed" },
      revisions: [
        { id: "r1", revision: 1, observedAt: t(1), title: "SRE", descriptionText: JD, changeKind: "first_seen" },
        { id: "r2", revision: 2, observedAt: t(2), title: "InHire", descriptionText: "inhire • • • •", changeKind: "content" },
        { id: "r3", revision: 3, observedAt: t(3), title: "SRE", descriptionText: JD, changeKind: "content" },
      ],
      evaluations: [
        { id: "e1", kind: "evaluate", createdAt: t(1) },
        { id: "e2", kind: "evaluate", createdAt: t(2) },
        { id: "e3", kind: "evaluate", createdAt: t(3) },
      ],
    }, { positionId: "pos_x", supersedeFrom: t(2), supersedeUntil: t(3), enqueue: [] });
    expect(plan.goodRevisionId).toBe("r3");
    expect(plan.supersede).toEqual(["e2"]);
    expect(plan.revisions.find((r) => r.id === "r2")?.passesGuard).toBe(false);
    expect(plan.steps[1]).toMatchObject({ detail: { from: "changed", to: "open" } });
  });
});

describe("materials status needs materials", () => {
  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
    await bootstrap({ seedBoards: false });
  });

  it("refuses a move to materials with nothing on file, allows it once drafts exist", async () => {
    const { position } = await upsertFromJob(inhire("e5"), { status: "review" });
    await expect(patchPosition(position.id, { status: "materials" }, "agent")).rejects.toBeInstanceOf(MaterialsMissingError);
    expect((await getPosition(position.id))!.status).toBe("review");
    await saveMaterial({ positionId: position.id, kind: "resume", bodyMarkdown: "# Resume" });
    expect((await patchPosition(position.id, { status: "materials" }, "agent"))!.status).toBe("materials");
  });

  it("a packaged career-ops PDF counts as materials", async () => {
    const { position } = await upsertFromJob(inhire("f6"), { status: "review" });
    await stampCareerOps(position.id, { trackerId: "9001", pdfPath: "output/cv.pdf" });
    expect((await patchPosition(position.id, { status: "materials" }, "agent"))!.status).toBe("materials");
  });

  it("approving a move to materials before drafts exist queues them and keeps the stage", async () => {
    const { position } = await upsertFromJob(inhire("g7"), { status: "review" });
    const approval = (await createApproval({ kind: "status_suggestion", positionId: position.id, title: "Apply", payload: { toStatus: "materials" } }))!;
    const r = await resolveApproval(approval.id, "approved");
    expect(r).toMatchObject({ status: "approved", applied: true, materialsJobId: expect.any(String) });
    expect((await getPosition(position.id))!.status).toBe("review");
  });

  it("the repair lists materials-without-files and reverts only with apply", async () => {
    const { position } = await upsertFromJob(inhire("h8"), { status: "review" });
    const db = await getDb();
    await db.update(positions).set({ status: "materials" }).where(eq(positions.id, position.id));
    await db.insert(timelineEvents).values({ id: "tl_h8", positionId: position.id, kind: "status", title: "review → materials", actor: "agent" });
    const listed = (await listMaterialsWithoutFiles()).find((a) => a.id === position.id);
    expect(listed).toMatchObject({ from: "review", revertTo: "review", enteredBy: "agent" });
    expect((await repairMaterialsWithoutFiles()).dryRun).toBe(true);
    expect((await getPosition(position.id))!.status).toBe("materials");
    await repairMaterialsWithoutFiles({ apply: true });
    expect((await getPosition(position.id))!.status).toBe("review");
  });
});

describe("career-ops stamp drift", () => {
  it("a job-scout-originated stamp follows status; a tracker stamp is flagged stale", async () => {
    const own = (await upsertFromJob(inhire("i9"), { status: "triaged" })).position;
    await stampCareerOps(own.id, { status: "triaged" });
    await patchPosition(own.id, { status: "applied" }, "agent");
    const ownStamp = (await getPosition(own.id))!.metadata?.careerOps as Record<string, unknown>;
    expect(ownStamp).toMatchObject({ status: "applied", jsStatus: "applied" });
    expect(careerOpsStampState("applied", ownStamp)?.stale).toBe(false);

    const linked = (await upsertFromJob(inhire("j10"), { status: "review" })).position;
    await stampCareerOps(linked.id, { trackerId: "42", status: "Evaluated" });
    await patchPosition(linked.id, { status: "applied" }, "agent");
    const stamp = (await getPosition(linked.id))!.metadata?.careerOps as Record<string, unknown>;
    expect(stamp).toMatchObject({ status: "Evaluated", jsStatus: "applied" });
    expect(careerOpsStampState("applied", stamp)).toMatchObject({ stale: true, stampStage: "review" });
  });
});
