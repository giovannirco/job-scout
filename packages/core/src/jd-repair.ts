import { and, desc, eq, ne } from "drizzle-orm";
import { evaluations, getDb, id, jdRevisions, positions } from "@job-scout/db";
import { bodySignature, classifyListing, contentHash, craftFamily, titleSignature, titleSimilarity } from "@job-scout/shared";
import { fetchJob } from "./fetch-job.js";
import { enqueueJob } from "./jobs.js";
import { getPosition } from "./positions.js";
import { reslugSuggestion, withPrevious } from "./slug-repair.js";
import { addEvent } from "./timeline.js";

/**
 * Restore a position's JD from its last good revision after a clobber (another
 * company's posting, a JS wall, a placeholder). Presets live outside the
 * repository (they name real positions); see cli/repair-last-good-jd.ts.
 */
export type LastGoodRepairPreset = {
  positionId: string;
  /** Only revisions observed before this instant are candidates (the clobber time). */
  before?: string;
  /** Supersede every evaluation created in [supersedeFrom, supersedeUntil). */
  supersedeFrom?: string;
  supersedeUntil?: string;
  /** Extra evaluation ids to supersede. */
  supersedeEvaluations?: string[];
  /** Jobs to queue after the restore. Default: jd_review + forced triage. */
  enqueue?: Array<"jd_review" | "triage">;
  /** Reslug when the slug was derived from a not-a-JD title (old slug kept in metadata.previousSlugs). */
  reslug?: boolean;
  /** Fetch the live posting (read-only) and compare its title with the restored one. Database mode only. */
  liveCheck?: boolean;
};

export type RepairSnapshot = {
  position: { id: string; title: string; status: string; listingStatus: string | null; slug?: string; company?: { slug: string } };
  revisions: Array<{ id: string; revision: number; observedAt: string | Date; title: string | null; locationRaw?: string | null; descriptionText?: string | null; changeKind: string }>;
  evaluations: Array<{ id: string; kind: string; createdAt: string | Date; json?: Record<string, unknown> | null }>;
};

export type RepairStep = { step: string; detail: Record<string, unknown> };

const at = (v: string | Date) => (v instanceof Date ? v : new Date(v));

/** A revision that may be restored: a real title, no not-a-JD signature, not a closure. */
export function revisionPassesGuard(r: { title: string | null; descriptionText?: string | null; changeKind: string }): boolean {
  return Boolean((r.title || "").trim()) && !titleSignature(r.title) && !bodySignature(r.descriptionText) && r.changeKind !== "closed";
}

/** Pure plan: which revision to restore, which evaluations to supersede, what to queue. */
export function planLastGoodRepair(s: RepairSnapshot, p: LastGoodRepairPreset) {
  const cutoff = p.before ? new Date(p.before) : null;
  const revs = [...s.revisions].sort((a, b) => b.revision - a.revision);
  const good = revs.find((r) => revisionPassesGuard(r) && (!cutoff || at(r.observedAt) < cutoff));
  const from = p.supersedeFrom ? new Date(p.supersedeFrom) : null;
  const until = p.supersedeUntil ? new Date(p.supersedeUntil) : null;
  const inWindow = from
    ? s.evaluations.filter((e) => at(e.createdAt) >= from && (!until || at(e.createdAt) < until)).map((e) => e.id)
    : [];
  const wanted = [...new Set([...(p.supersedeEvaluations || []), ...inWindow])];
  const known = new Map(s.evaluations.map((e) => [e.id, e]));
  const supersede = wanted.filter((i) => known.has(i) && !(known.get(i)!.json as { superseded?: unknown } | null | undefined)?.superseded);
  const enqueue = p.enqueue ?? ["jd_review", "triage"];
  const restoredTitle = good ? good.title || s.position.title : s.position.title;
  const canReslug = Boolean(s.position.slug && s.position.company?.slug);
  const reslug = p.reslug && canReslug ? reslugSuggestion({ id: s.position.id, slug: s.position.slug!, company: s.position.company! }, restoredTitle) : null;
  const reslugStep = p.reslug
    ? [{ step: "reslug", detail: reslug ? { ...reslug, previousSlugs: "append old slug" } : { skipped: canReslug ? "slug not derived from a not-a-JD title" : "snapshot has no slug/company", slug: s.position.slug ?? null } }]
    : [];
  return {
    positionId: s.position.id,
    current: { title: s.position.title, status: s.position.status, listingStatus: s.position.listingStatus, latestRevision: revs[0]?.revision ?? null },
    revisions: revs.map((r) => ({ revision: r.revision, id: r.id, observedAt: at(r.observedAt).toISOString(), title: r.title, passesGuard: revisionPassesGuard(r), beforeCutoff: !cutoff || at(r.observedAt) < cutoff })),
    error: good ? undefined : `no revision passes the page guard${p.before ? ` before ${p.before}` : ""}`,
    steps: (good
      ? [
          { step: "restore_revision", detail: { fromRevision: good.revision, fromRevisionId: good.id, title: good.title, location: good.locationRaw || "", ...(good.revision === revs[0]?.revision ? { noop: "already the latest revision" } : {}) } },
          ...reslugStep,
          { step: "listing_status", detail: { from: s.position.listingStatus, to: s.position.listingStatus === "changed" ? "open" : s.position.listingStatus } },
          { step: "supersede_evaluations", detail: { ids: supersede, alreadySuperseded: wanted.filter((i) => known.has(i) && !supersede.includes(i)), missing: wanted.filter((i) => !known.has(i)), window: from ? { from: from.toISOString(), until: until?.toISOString() ?? null } : null } },
          { step: "enqueue", detail: { jobs: enqueue.map((j) => (j === "triage" ? "triage(force)" : j)) } },
        ]
      : []) as RepairStep[],
    goodRevisionId: good?.id ?? null,
    restoreNeeded: Boolean(good && good.revision !== revs[0]?.revision),
    supersede,
    enqueue,
    reslug,
  };
}

/** Read-only: fetch the live posting and compare its title with the one the repair restores. Never writes. */
export async function liveTitleCheck(url: string | null | undefined, restoredTitle: string) {
  if (!url) return { error: "position has no URL" };
  try {
    const job = await fetchJob(url);
    const similarity = titleSimilarity(job.title, restoredTitle);
    return { url, liveTitle: job.title, restoredTitle, listingStatus: job.listingStatus, similarity, matches: similarity >= 0.6 && !titleSignature(job.title) };
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Plan (dry-run, default) or apply a last-good-revision repair against the database. */
export async function repairToLastGoodRevision(p: LastGoodRepairPreset, opts: { apply?: boolean } = {}) {
  const db = await getDb();
  const pos = await getPosition(p.positionId);
  if (!pos) throw new Error(`position not found: ${p.positionId}`);
  const revisions = await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, pos.id)).orderBy(desc(jdRevisions.revision));
  const evs = await db.select({ id: evaluations.id, kind: evaluations.kind, createdAt: evaluations.createdAt, json: evaluations.json }).from(evaluations).where(eq(evaluations.positionId, pos.id));
  const plan = planLastGoodRepair({ position: { id: pos.id, title: pos.title, status: pos.status, listingStatus: pos.listingStatus, slug: pos.slug, company: { slug: pos.company.slug } }, revisions, evaluations: evs }, p);
  const restoredTitle = revisions.find((r) => r.id === plan.goodRevisionId)?.title || pos.title;
  const live = p.liveCheck ? await liveTitleCheck(pos.primaryUrl, restoredTitle) : null;
  // The target slug must be free; otherwise the reslug is skipped, never forced.
  let reslug = plan.reslug;
  if (reslug && (await db.select({ id: positions.id }).from(positions).where(and(eq(positions.slug, reslug.to), ne(positions.id, pos.id))).limit(1)).length) {
    plan.steps = plan.steps.map((st) => (st.step === "reslug" ? { step: "reslug", detail: { skipped: "target slug taken", ...reslug } } : st));
    reslug = null;
  }
  if (!opts.apply || !plan.goodRevisionId) return { dryRun: !opts.apply, ...plan, reslug, live };

  const good = revisions.find((r) => r.id === plan.goodRevisionId)!;
  const restore = plan.restoreNeeded;
  const now = new Date();
  const title = good.title || pos.title;
  const location = good.locationRaw || "";
  const facts = classifyListing({ locationRaw: location, company: pos.company.name, title, descriptionText: good.descriptionText || "" });
  const hash = contentHash({ title, descriptionText: good.descriptionText || "", salaryRaw: good.salaryRaw, locationRaw: location });
  if (restore) await db.insert(jdRevisions).values({
    id: id("jdr"), positionId: pos.id, revision: (revisions[0]?.revision ?? 0) + 1, observedAt: now, contentHash: hash, changeKind: "repair", material: false,
    title, locationRaw: location || null, descriptionText: good.descriptionText,
    salaryMin: good.salaryMin, salaryMax: good.salaryMax, salaryCurrency: good.salaryCurrency, salaryPeriod: good.salaryPeriod, salaryRaw: good.salaryRaw,
    remoteClass: facts.remoteClass, geoClass: facts.geoClass, diffSummary: `repair: restored from ${good.id} (r${good.revision})`, fieldDiffs: [], source: "repair",
  });
  await db.update(positions).set({
    ...(restore ? { title, contentHash: hash, craftFamily: craftFamily(title), geoClass: facts.geoClass, remoteClass: facts.remoteClass, workplace: facts.workplace } : {}),
    listingStatus: pos.listingStatus === "changed" ? "open" : pos.listingStatus, updatedAt: now,
    ...(reslug ? { slug: reslug.to } : {}),
    metadata: (() => {
      const m = { ...(pos.metadata || {}), jdRepair: { at: now.toISOString(), restoredFrom: good.id, previousTitle: pos.title } };
      return reslug ? withPrevious(m, reslug.from) : m;
    })(),
  }).where(eq(positions.id, pos.id));
  if (reslug) await addEvent({ positionId: pos.id, kind: "repair", title: `Slug repaired: ${reslug.from} → ${reslug.to}`, actor: "repair:last-good-jd", metadata: { from: reslug.from, to: reslug.to } });
  if (restore) await addEvent({ positionId: pos.id, kind: "harness", title: `JD repaired from ${good.id} (r${good.revision})`, body: `title → ${title}; location → ${location}`, actor: "repair" });
  if (plan.supersede.length) {
    for (const e of evs.filter((x) => plan.supersede.includes(x.id))) {
      await db.update(evaluations).set({ json: { ...(e.json || {}), superseded: { at: now.toISOString(), reason: "scored on a clobbered JD", byRevision: good.id } } }).where(eq(evaluations.id, e.id));
    }
    await addEvent({ positionId: pos.id, kind: "harness", title: `Superseded evaluations: ${plan.supersede.join(", ")}`.slice(0, 300), actor: "repair" });
  }
  const jobs: Record<string, string> = {};
  if (plan.enqueue.includes("jd_review")) jobs.jd_review = (await enqueueJob("jd_review", { positionId: pos.id }, { dedupeKey: `jd_review:${pos.id}`, priority: 30 })).id;
  if (plan.enqueue.includes("triage")) jobs.triage = (await enqueueJob("triage", { positionId: pos.id, force: true }, { dedupeKey: `triage:${pos.id}`, priority: 30 })).id;
  return { dryRun: false as const, ...plan, reslug, live, jobs };
}

