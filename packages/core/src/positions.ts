import { and, asc, desc, eq, gt, gte, ilike, inArray, notInArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  applicationMaterials,
  applicationQuestions,
  companies,
  evaluations,
  getDb,
  id,
  jdRevisions,
  positions,
  slugify,
  type PositionStatus,
} from "@job-scout/db";
import type { AtsJob } from "@job-scout/ats";
import { fetchJob as fetchJobFromUrl } from "./fetch-job.js";
import {
  classifyMateriality,
  contentHash,
  craftFamily,
  fieldDiffs,
  classifyListing,
  parseListSort,
  isShellJobTitle,
  isPlaceholderAtsUrl,
  parseSalary,
  preferJobTitle,
  summarizeDiffs,
  HOT_STATUSES,
  PipelineStatus,
  isNoiseJobTitle, cleanLocation, canonicalExternalIdentity, normalizePostingUrl,
  employerFromPosting, unresolvedCompany, UNRESOLVED_COMPANY, requisitionId,
} from "@job-scout/shared";
import { resolveCompanyForName } from "./companies.js";
import { addEvent } from "./timeline.js";
import { jdChanges, watchChecks, ingestQuality } from "./metrics.js";
import { careerStamp, groupingRows, groupRows, groupSummary, repostFor, terminalCareerStatus, validOperatorRow } from "./position-groups.js";
import { getProfile, profileFingerprint } from "./profile.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "positions" });

export type Position = typeof positions.$inferSelect;

const SLIM_COMPANY = {
  id: companies.id,
  slug: companies.slug,
  name: companies.name,
  website: companies.website,
};

const LIST_ROW = {
  id: positions.id,
  slug: positions.slug,
  title: positions.title,
  status: positions.status,
  priority: positions.priority,
  primaryUrl: positions.primaryUrl,
  atsProvider: positions.atsProvider,
  craftFamily: positions.craftFamily,
  geoClass: positions.geoClass,
  remoteClass: positions.remoteClass,
  workplace: positions.workplace,
  triageScore: positions.triageScore,
  triageVerdict: positions.triageVerdict,
  triageOneLiner: sql<string | null>`${positions.triageJson}->>'oneLiner'`,
  salaryMin: positions.salaryMin,
  salaryMax: positions.salaryMax,
  salaryCurrency: positions.salaryCurrency,
  locationRaw: sql<string | null>`(select jr.location_raw from jd_revisions jr where jr.position_id = ${positions.id} order by jr.revision desc limit 1)`,
  listingStatus: positions.listingStatus,
  watchEnabled: positions.watchEnabled,
  appliedAt: positions.appliedAt,
  firstSeenAt: positions.firstSeenAt,
  lastChangedAt: positions.lastChangedAt,
  triagedAt: positions.triagedAt,
  triageProfileHash: sql<string | null>`${positions.triageJson}->>'profileHash'`,
  repostOfId: sql<string | null>`${positions.metadata}->>'repostOfId'`,
  repost: sql<Record<string, unknown> | null>`${positions.metadata}->'repost'`,
  updatedAt: positions.updatedAt,
  /** career-ops tracker stamp (trackerId, score, status, reportPath) — small, useful in lists */
  careerOps: sql<Record<string, unknown> | null>`case when ${positions.metadata} ? 'careerOps' then jsonb_build_object(
    'trackerId', ${positions.metadata}->'careerOps'->'trackerId',
    'score', ${positions.metadata}->'careerOps'->'score',
    'status', ${positions.metadata}->'careerOps'->'status',
    'reportPath', ${positions.metadata}->'careerOps'->'reportPath',
    'syncedAt', ${positions.metadata}->'careerOps'->'syncedAt',
    'trackerUpdatedAt', ${positions.metadata}->'careerOps'->'trackerUpdatedAt',
    'reportStatus', ${positions.metadata}->'careerOps'->'reportStatus') end`,
  company: SLIM_COMPANY,
};

export type ListPositionsQuery = {
  page?: string;
  pageSize?: string;
  /** cursor = updatedAt ISO|id from previous page (for MCP) */
  cursor?: string;
  status?: string; // comma list; "hot" alias; "active" = not archived
  verdict?: string; // comma list
  company?: string;
  q?: string;
  geoClass?: string;
  workplace?: string;
  listingStatus?: string;
  minScore?: string;
  watch?: string;
  sort?: string;
  includeArchived?: string;
  includeDuplicates?: string;
  collapseFamilies?: string;
  actionable?: string;
  withoutEvaluation?: string;
  staleProfile?: string;
  reviewLane?: "pending" | "failed";
};

export async function listPositions(q: ListPositionsQuery) {
  const db = await getDb();
  const page = Math.max(1, Math.floor(Number(q.page)) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(q.pageSize)) || 50));
  const conds: SQL[] = [];
  const [allRows, profile] = await Promise.all([groupingRows(), getProfile()]);
  const profileHash = profileFingerprint(profile);
  const groups = groupRows(allRows.filter(validOperatorRow), q.collapseFamilies === "true");
  const summaries = new Map(groups.flatMap(g => g.map(r => [r.id, {
    ...groupSummary(g), duplicateCount: groupRows(g).find(d => d.some(p => p.id === r.id))?.length || 1,
    duplicateOfId: g[0].id === r.id ? null : g[0].id,
  }] as const)));
  if (q.includeDuplicates !== "true") {
    const hidden = groups.flatMap(g => g.slice(1).map(r => r.id));
    if (hidden.length) conds.push(notInArray(positions.id, hidden));
  }
  if (q.actionable === "true") {
    const hidden = allRows.filter(r => !validOperatorRow(r) || terminalCareerStatus(careerStamp(r).status)).map(r => r.id);
    if (hidden.length) conds.push(notInArray(positions.id, hidden));
    conds.push(sql`${positions.listingStatus} is distinct from 'closed'`);
  }
  if (q.withoutEvaluation === "true") conds.push(sql`not exists (select 1 from evaluations e where e.position_id = ${positions.id} and e.kind = 'evaluate')`);
  if (q.staleProfile === "true") conds.push(sql`${positions.triagedAt} is not null and ${positions.triageJson}->>'profileHash' is distinct from ${profileHash}`);
  if (q.reviewLane) {
    const deliberateReview = sql`(${positions.metadata}->'reviewIntent'->>'kind' = 'operator'
      or (select t.actor = 'operator' and t.title like '% → review' from timeline_events t where t.position_id = ${positions.id} and t.kind = 'status'
        order by t.created_at desc, t.id desc limit 1))`;
    const failedWithoutOverride = sql`(${positions.triageVerdict} = 'fail' and not coalesce(${deliberateReview}, false))`;
    conds.push(q.reviewLane === "failed" ? failedWithoutOverride : sql`not coalesce(${failedWithoutOverride}, false)`);
  }

  if (q.status) {
    const parts = q.status.split(",").map((s) => s.trim()).filter(Boolean);
    const expanded = parts.flatMap((p) => (p === "hot" ? [...HOT_STATUSES] : p === "active" || p === "all" ? [] : [p]));
    if (parts.includes("all")) {
      /* no status constraint: archived included */
    } else if (parts.includes("active")) conds.push(sql`${positions.status} <> 'archived'`);
    else if (expanded.length) conds.push(inArray(positions.status, expanded as PositionStatus[]));
  } else if (q.includeArchived !== "true") {
    conds.push(sql`${positions.status} <> 'archived'`);
  }
  if (q.verdict) {
    const v = q.verdict.split(",").map((s) => s.trim()).filter(Boolean);
    if (v.includes("none")) {
      const rest = v.filter((x) => x !== "none");
      conds.push(rest.length ? or(sql`${positions.triageVerdict} is null`, inArray(positions.triageVerdict, rest as never))! : sql`${positions.triageVerdict} is null`);
    } else if (v.length) conds.push(inArray(positions.triageVerdict, v as never));
  }
  if (q.geoClass) conds.push(eq(positions.geoClass, q.geoClass));
  if (q.workplace) conds.push(eq(positions.workplace, q.workplace));
  if (q.listingStatus) conds.push(eq(positions.listingStatus, q.listingStatus));
  if (q.minScore) conds.push(gte(positions.triageScore, Number(q.minScore)));
  if (q.watch === "true") conds.push(eq(positions.watchEnabled, true));
  if (q.company) conds.push(or(eq(companies.slug, q.company), eq(companies.id, q.company), ilike(companies.name, `%${q.company}%`))!);
  if (q.q) {
    const like = `%${q.q}%`;
    conds.push(or(ilike(positions.title, like), ilike(companies.name, like), ilike(positions.slug, like))!);
  }
  if (q.cursor) {
    if (q.sort && q.sort !== "updated_desc") throw new Error("cursor requires sort=updated_desc; use page for other sorts");
    const [ts, cid] = q.cursor.split("|");
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      conds.push(or(lt(positions.updatedAt, d), and(eq(positions.updatedAt, d), lt(positions.id, cid || "")))!);
    }
  }

  const where = conds.length ? and(...conds) : undefined;
  const { field, dir } = parseListSort(
    q.sort,
    ["updated", "score", "company", "status", "first_seen", "last_changed", "title", "workplace", "geo", "location"],
    "updated",
    "desc",
  );
  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order =
    field === "score"
      ? [d(sql`coalesce(${positions.triageScore}, -1)`), desc(positions.updatedAt)]
      : field === "company"
        ? [d(companies.name), desc(positions.updatedAt)]
        : field === "status"
          ? [d(positions.status), desc(positions.updatedAt)]
          : field === "first_seen"
            ? [d(positions.firstSeenAt), desc(positions.id)]
            : field === "last_changed"
              ? [d(positions.lastChangedAt), desc(positions.id)]
            : field === "title"
              ? [d(positions.title), desc(positions.id)]
              : field === "workplace"
                ? [d(positions.workplace), desc(positions.updatedAt)]
                : field === "geo"
                  ? [d(positions.geoClass), desc(positions.updatedAt)]
                  : field === "location"
                    ? [
                        d(
                          sql`(select jr.location_raw from jd_revisions jr where jr.position_id = ${positions.id} order by jr.revision desc limit 1)`,
                        ),
                        desc(positions.updatedAt),
                      ]
                    : [d(positions.updatedAt), desc(positions.id)];

  const rows = await db
    .select(LIST_ROW)
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(where)
    .orderBy(...order)
    .limit(pageSize)
    .offset(q.cursor ? 0 : (page - 1) * pageSize);

  const total = (
    await db
      .select({ c: sql<number>`count(*)::int` })
      .from(positions)
      .innerJoin(companies, eq(positions.companyId, companies.id))
      .where(where)
  )[0]?.c ?? 0;

  const last = rows[rows.length - 1];
  const nextCursor = field === "updated" && dir === "desc" && rows.length === pageSize && last ? `${last.updatedAt.toISOString()}|${last.id}` : null;
  return { items: rows.map(row => ({ ...row, ...summaries.get(row.id),
    triageStale: !!row.triagedAt && row.triageProfileHash !== profileHash,
    careerOpsStale: !!row.careerOps?.trackerUpdatedAt && (!row.careerOps.syncedAt || String(row.careerOps.trackerUpdatedAt) > String(row.careerOps.syncedAt)),
  })), page, pageSize, total, nextCursor };
}

export async function getPosition(idOrSlug: string) {
  const db = await getDb();
  const row = (
    await db
      .select({ position: positions, company: companies })
      .from(positions)
      .innerJoin(companies, eq(positions.companyId, companies.id))
      .where(or(eq(positions.id, idOrSlug), eq(positions.slug, idOrSlug)))
      .limit(1)
  )[0];
  if (!row) return null;
  return { ...row.position, company: row.company };
}

/** Full detail: position + current JD + evaluation summaries + material versions. */
export async function getPositionDetail(idOrSlug: string) {
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  const db = await getDb();
  const [revs, evals, mats, qs] = await Promise.all([
    db
      .select({
        id: jdRevisions.id,
        revision: jdRevisions.revision,
        observedAt: jdRevisions.observedAt,
        changeKind: jdRevisions.changeKind,
        material: jdRevisions.material,
        diffSummary: jdRevisions.diffSummary,
        title: jdRevisions.title,
        locationRaw: jdRevisions.locationRaw,
        salaryRaw: jdRevisions.salaryRaw,
      })
      .from(jdRevisions)
      .where(eq(jdRevisions.positionId, pos.id))
      .orderBy(desc(jdRevisions.revision))
      .limit(50),
    db
      .select({
        id: evaluations.id,
        kind: evaluations.kind,
        model: evaluations.model,
        json: evaluations.json,
        createdAt: evaluations.createdAt,
        tokensIn: evaluations.tokensIn,
        tokensOut: evaluations.tokensOut,
      })
      .from(evaluations)
      .where(eq(evaluations.positionId, pos.id))
      .orderBy(desc(evaluations.createdAt))
      .limit(20),
    db
      .select({
        id: applicationMaterials.id,
        kind: applicationMaterials.kind,
        version: applicationMaterials.version,
        isCurrent: applicationMaterials.isCurrent,
        status: applicationMaterials.status,
        model: applicationMaterials.model,
        createdAt: applicationMaterials.createdAt,
        hasPdf: sql<boolean>`${applicationMaterials.pdfBase64} is not null`,
      })
      .from(applicationMaterials)
      .where(eq(applicationMaterials.positionId, pos.id))
      .orderBy(desc(applicationMaterials.createdAt))
      .limit(50),
    db
      .select({ status: applicationQuestions.status, answer: applicationQuestions.answer })
      .from(applicationQuestions)
      .where(eq(applicationQuestions.positionId, pos.id)),
  ]);
  const current = revs[0]
    ? (
        await db
          .select({ descriptionText: jdRevisions.descriptionText, techTags: jdRevisions.techTags })
          .from(jdRevisions)
          .where(eq(jdRevisions.id, revs[0].id))
          .limit(1)
      )[0]
    : null;
  const ats = (pos.metadata?.ats && typeof pos.metadata.ats === "object" ? pos.metadata.ats : {}) as {
    postedAt?: string | null;
    departments?: string[];
    team?: string | null;
  };
  const departments = [
    ...(Array.isArray(ats.departments) ? ats.departments.filter((d) => typeof d === "string" && d.trim()) : []),
  ];
  if (typeof ats.team === "string" && ats.team.trim() && !departments.includes(ats.team)) departments.push(ats.team);
  const profileHash = profileFingerprint(await getProfile());
  const family = groupRows((await groupingRows()).filter(validOperatorRow), true).find(g => g.some(r => r.id === pos.id));
  return {
    ...pos,
    ...(family ? groupSummary(family) : {}),
    triageStale: !!pos.triagedAt && pos.triageJson?.profileHash !== profileHash,
    repostOfId: pos.metadata?.repostOfId as string | undefined,
    repost: pos.metadata?.repost as Record<string, unknown> | undefined,
    locationRaw: revs[0]?.locationRaw ?? null,
    postedAt: typeof ats.postedAt === "string" && ats.postedAt ? ats.postedAt : null,
    departments,
    jd: current ? { revision: revs[0]!.revision, descriptionText: current.descriptionText, techTags: current.techTags } : null,
    revisions: revs,
    evaluations: evals.map(e => ({ ...e, profileStale: e.kind === "evaluate" && e.json?.profileHash !== profileHash })),
    materials: mats,
    questions: {
      total: qs.length,
      open: qs.filter((q) => q.status === "open").length,
      drafted: qs.filter((q) => q.status === "open" && Boolean(q.answer?.trim())).length,
    },
  };
}

export async function getRevision(positionId: string, revision: number) {
  const db = await getDb();
  return (
    await db
      .select()
      .from(jdRevisions)
      .where(and(eq(jdRevisions.positionId, positionId), eq(jdRevisions.revision, revision)))
      .limit(1)
  )[0] ?? null;
}

export async function currentJdText(positionId: string): Promise<string> {
  const db = await getDb();
  const r = (
    await db
      .select({ t: jdRevisions.descriptionText })
      .from(jdRevisions)
      .where(eq(jdRevisions.positionId, positionId))
      .orderBy(desc(jdRevisions.revision))
      .limit(1)
  )[0];
  return r?.t || "";
}

const PATCHABLE = new Set([
  "title",
  "status",
  "priority",
  "primaryUrl",
  "resumeSurface",
  "nextAction",
  "notes",
  "watchEnabled",
  "appliedAt",
  "equityNotes",
  "archiveReason",
  "geoNotes",
]);

export async function patchPosition(idOrSlug: string, patch: Record<string, unknown>, actor = "operator") {
  const db = await getDb();
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue;
    if (k === "status") {
      const s = PipelineStatus.safeParse(v);
      if (!s.success) throw new Error(`invalid status ${String(v)}`);
      set.status = s.data;
      if (s.data === "applied" && !pos.appliedAt) set.appliedAt = new Date();
      if (s.data !== "archived") set.archiveReason = null;
    } else if (k === "appliedAt") set.appliedAt = v ? new Date(String(v)) : null;
    else set[k] = v;
  }
  if (patch.metadata && typeof patch.metadata === "object") {
    set.metadata = { ...(pos.metadata || {}), ...(patch.metadata as object) };
  }
  if (set.status) {
    const metadata = { ...(pos.metadata || {}), ...((set.metadata || {}) as Record<string, unknown>) };
    const automated = /^(system|autopilot|career-ops|intake|scan(?::.*)?|triage|evaluate|import|seed)$/.test(actor);
    if (set.status === "review" && !automated) metadata.reviewIntent = { kind: "operator", actor, at: new Date().toISOString() };
    else delete metadata.reviewIntent;
    set.metadata = metadata;
  }
  await db.update(positions).set(set).where(eq(positions.id, pos.id));
  if (set.status && set.status !== pos.status) {
    await addEvent({ positionId: pos.id, kind: "status", title: `${pos.status} → ${String(set.status)}`, actor });
    if ((HOT_STATUSES as readonly string[]).includes(String(set.status))) {
      const { emitNotify } = await import("./notify.js");
      await emitNotify({
        event: "status_hot",
        title: pos.title,
        company: pos.company.name,
        slug: pos.slug,
        extra: `${pos.status} → ${String(set.status)}`,
        url: pos.primaryUrl,
        positionId: pos.id,
        companyId: pos.companyId,
        subjectId: pos.id,
        revision: String(set.status),
      });
    }
  }
  return getPosition(pos.id);
}

export async function archivePosition(idOrSlug: string, reason: string, actor = "operator") {
  const db = await getDb();
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  await db
    .update(positions)
    .set({ status: "archived", archiveReason: reason.slice(0, 300), watchEnabled: false, updatedAt: new Date() })
    .where(eq(positions.id, pos.id));
  await addEvent({ positionId: pos.id, kind: "status", title: `archived: ${reason}`, actor });
  return getPosition(pos.id);
}

/** Merge a career-ops stamp into metadata.careerOps (id, score, status, paths). */
export async function stampCareerOps(idOrSlug: string, stamp: Record<string, unknown>) {
  const db = await getDb();
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  const next = { ...stamp, syncedAt: new Date().toISOString() };
  const [updated] = await db
    .update(positions)
    .set({ metadata: sql`jsonb_set(coalesce(${positions.metadata}, '{}'::jsonb), '{careerOps}', coalesce(${positions.metadata}->'careerOps', '{}'::jsonb) || ${JSON.stringify(next)}::jsonb)`, updatedAt: new Date() })
    .where(eq(positions.id, pos.id)).returning();
  const meta = (updated?.metadata || {}) as Record<string, unknown>;
  return meta.careerOps;
}

/**
 * Apply a fresh ATS snapshot to an existing position. Writes a jd_revision only
 * when content/title/comp/status actually changed. A closed listing gets exactly
 * one `closed` revision.
 */
export async function applySnapshot(opts: { positionId: string; job: AtsJob; source?: string }) {
  const db = await getDb();
  const pos = await getPosition(opts.positionId);
  if (!pos) throw new Error("position not found");

  const title = preferJobTitle(isNoiseJobTitle(opts.job.title) ? "" : opts.job.title, pos.title, { slug: pos.slug, companySlug: pos.company.slug });
  const incomingShell = isNoiseJobTitle(opts.job.title);
  const descriptionText = (opts.job.descriptionText || "").trim();
  const locationRaw = cleanLocation(opts.job.locationRaw);
  const salaryRaw = (opts.job.salaryRaw || "").trim() || null;
  const salary = parseSalary(salaryRaw);
  const nextUrl = opts.job.url && !isPlaceholderAtsUrl(opts.job.url) ? opts.job.url : pos.primaryUrl;
  const listingClosed = opts.job.listingStatus === "closed";
  const observedStatus = opts.job.listingStatus === "open" || listingClosed ? opts.job.listingStatus : pos.listingStatus;
  const now = new Date();
  if (listingClosed && ["triaged", "review"].includes(pos.status)) {
    await archivePosition(pos.id, "listing_closed", "system");
  }

  const touch = async (extra: Record<string, unknown> = {}) => {
    await db
      .update(positions)
      .set({
        lastCheckedAt: now,
        updatedAt: now,
        metadata: {
          ...(pos.metadata || {}),
          lastAtsFetch: { at: now.toISOString(), provider: opts.job.provider, listingStatus: opts.job.listingStatus },
        },
        ...extra,
      })
      .where(eq(positions.id, pos.id));
  };

  if (listingClosed && pos.listingStatus === "closed") {
    await touch();
    await afterAtsFetch(pos.id, opts.job);
    return { changed: false as const, revision: null };
  }

  const hash = contentHash({
    title,
    descriptionText: descriptionText || (incomingShell ? "__shell_skip__" : ""),
    salaryRaw,
    locationRaw,
  });

  if (pos.contentHash === hash && !listingClosed && pos.listingStatus !== "closed") {
    await touch({ primaryUrl: nextUrl });
    await afterAtsFetch(pos.id, opts.job);
    return { changed: false as const, revision: null };
  }
  if (incomingShell && !listingClosed && !descriptionText) {
    await touch({ title });
    await afterAtsFetch(pos.id, opts.job);
    return { changed: false as const, revision: null };
  }

  const prevRev = (
    await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, pos.id)).orderBy(desc(jdRevisions.revision)).limit(1)
  )[0];
  const nextRev = (prevRev?.revision ?? 0) + 1;
  const bodyText = descriptionText || (listingClosed ? prevRev?.descriptionText || "" : "");

  const before = {
    title: prevRev?.title ?? pos.title,
    location_raw: prevRev?.locationRaw ?? "",
    salary_raw: prevRev?.salaryRaw ?? pos.salaryRaw ?? "",
    description_text: prevRev?.descriptionText ?? "",
    listing_status: pos.listingStatus,
  };
  const after = {
    title,
    location_raw: locationRaw || before.location_raw,
    salary_raw: salaryRaw ?? "",
    description_text: bodyText,
    listing_status: observedStatus,
  };
  const diffs = fieldDiffs(before, after, ["title", "location_raw", "salary_raw", "description_text", "listing_status"]).filter(
    (d) => !(d.path === "title" && isShellJobTitle(String(d.after ?? "")) && !isShellJobTitle(String(d.before ?? ""))),
  );
  if (!diffs.length && nextRev > 1) {
    await touch({ contentHash: hash });
    watchChecks.labels({ outcome: "unchanged" }).inc();
    return { changed: false as const, revision: null };
  }
  const { material, change_kind } = classifyMateriality(diffs, {
    forceKind: nextRev === 1 ? "first_seen" : listingClosed ? "closed" : undefined,
  });
  const loc = locationRaw || before.location_raw;
  const facts = classifyListing({
    locationRaw: loc,
    workplaceType: opts.job.workplaceType,
    isRemote: opts.job.isRemote,
    company: pos.company.name,
    title,
  });

  await db.insert(jdRevisions).values({
    id: id("jdr"),
    positionId: pos.id,
    revision: nextRev,
    observedAt: now,
    contentHash: hash,
    changeKind: change_kind,
    material,
    title,
    locationRaw: loc || null,
    descriptionText: bodyText,
    salaryMin: salary.min ?? pos.salaryMin,
    salaryMax: salary.max ?? pos.salaryMax,
    salaryCurrency: salary.currency || pos.salaryCurrency,
    salaryPeriod: salary.period || pos.salaryPeriod,
    salaryRaw,
    remoteClass: facts.remoteClass,
    geoClass: facts.geoClass,
    diffSummary: nextRev === 1 ? "first snapshot" : summarizeDiffs(diffs),
    fieldDiffs: diffs,
    source: opts.source || "scan",
  });

  const listingStatus = listingClosed ? "closed" : observedStatus === "open" ? (material && pos.listingStatus !== "closed" ? "changed" : "open") : pos.listingStatus || "unknown";
  await db
    .update(positions)
    .set({
      title,
      primaryUrl: nextUrl,
      atsProvider: opts.job.provider || pos.atsProvider,
      atsJobId: opts.job.jobId || pos.atsJobId,
      atsBoardToken: opts.job.boardToken || pos.atsBoardToken,
      externalIdentity: opts.job.externalIdentity || pos.externalIdentity,
      craftFamily: craftFamily(title),
      geoClass: facts.geoClass,
      remoteClass: facts.remoteClass,
      workplace: facts.workplace,
      salaryMin: salary.min ?? pos.salaryMin,
      salaryMax: salary.max ?? pos.salaryMax,
      salaryCurrency: salary.currency || pos.salaryCurrency,
      salaryPeriod: salary.period || pos.salaryPeriod,
      salaryRaw: salaryRaw ?? pos.salaryRaw,
      employmentType: opts.job.employmentType || pos.employmentType,
      contentHash: hash,
      listingStatus,
      lastCheckedAt: now,
      lastChangedAt: now,
      closedAt: listingStatus === "closed" ? pos.closedAt || now : null,
      firstSeenAt: pos.firstSeenAt || now,
      metadata: {
        ...(pos.metadata || {}),
        requisitionId: opts.job.requisitionId || requisitionId(bodyText),
        ats: {
          provider: opts.job.provider,
          boardToken: opts.job.boardToken,
          jobId: opts.job.jobId,
          applyUrl: opts.job.applyUrl || nextUrl,
          departments: opts.job.departments || [],
          offices: opts.job.offices || [],
          workplaceType: opts.job.workplaceType || null,
          isRemote: opts.job.isRemote ?? null,
          postedAt: opts.job.postedAt || null,
          updatedAtAts: opts.job.updatedAt || null,
          questions: (opts.job.questions || []).slice(0, 40),
          fetchedAt: now.toISOString(),
        },
        lastAtsFetch: { at: now.toISOString(), provider: opts.job.provider, listingStatus: opts.job.listingStatus },
      },
      updatedAt: now,
    })
    .where(eq(positions.id, pos.id));

  await addEvent({
    positionId: pos.id,
    kind: material ? "jd_change" : "jd_noise",
    title: nextRev === 1 ? "First JD snapshot" : `JD ${change_kind}`,
    body: summarizeDiffs(diffs),
  });
  jdChanges.labels({ change_kind, material: String(material) }).inc();
  watchChecks.labels({ outcome: listingClosed ? "closed" : nextRev === 1 ? "first_seen" : "changed" }).inc();
  log.info("jd.revision", { positionId: pos.id, revision: nextRev, changeKind: change_kind, material, closed: listingClosed, source: opts.source || "scan", fields: diffs.map((d) => d.path) });
  await afterAtsFetch(pos.id, opts.job, facts);
  if (material && nextRev > 1) {
    // dynamic import: autopilot depends on this module
    const { afterJdChange } = await import("./autopilot.js");
    await afterJdChange({ positionId: pos.id, status: pos.status, changeKind: change_kind, revision: nextRev });
    if ((HOT_STATUSES as readonly string[]).includes(pos.status) || listingClosed) {
      const { emitNotify } = await import("./notify.js");
      await emitNotify({
        event: listingClosed ? "listing_closed_hot" : "jd_change_hot",
        title: pos.title,
        company: pos.company.name,
        slug: pos.slug,
        extra: listingClosed ? "listing closed" : `JD ${change_kind}`,
        url: pos.primaryUrl,
        positionId: pos.id,
        companyId: pos.companyId,
        subjectId: pos.id,
        revision: nextRev,
      });
    }
  }
  return { changed: true as const, revision: nextRev, material, changeKind: change_kind };
}

/** Create-or-update a position from an ATS job. New positions start as `triaged` (untriaged until the LLM runs). */
export async function upsertFromJob(
  job: AtsJob,
  opts: { status?: PositionStatus; source?: string; companyName?: string; reviveArchived?: boolean } = {},
): Promise<{ position: NonNullable<Awaited<ReturnType<typeof getPosition>>>; created: boolean; revived: boolean }> {
  const db = await getDb();
  if (!job.url?.trim() || isPlaceholderAtsUrl(job.url)) {
    ingestQuality.labels({ reason: "placeholder_url" }).inc();
    log.warn("ingest.rejected", { reason: "placeholder_url", url: job.url });
    throw new Error("placeholder or invalid posting URL");
  }
  job = { ...job, locationRaw: cleanLocation(job.locationRaw) };
  const companyName = [opts.companyName, job.company, job.boardToken].find(n => !unresolvedCompany(n))
    || employerFromPosting(job.url, job.title) || UNRESOLVED_COMPANY;
  if (companyName === UNRESOLVED_COMPANY) {
    ingestQuality.labels({ reason: "unresolved_company" }).inc();
    log.warn("ingest.unresolved_company", { url: job.url });
  }
  const company = await resolveCompanyForName(companyName);
  const externalIdentity =
    canonicalExternalIdentity(job.externalIdentity || (job.provider && job.jobId ? `${job.provider}:${job.boardToken || company.slug}:${job.jobId}` : null));
  job.externalIdentity = externalIdentity || undefined;

  let existing = externalIdentity
    ? (await db.select({ id: positions.id }).from(positions).where(eq(positions.externalIdentity, externalIdentity)).limit(1))[0]
    : undefined;
  if (!existing && job.url) {
    existing = (await db.select({ id: positions.id }).from(positions).where(eq(positions.primaryUrl, job.url)).limit(1))[0];
  }
  if (!existing) {
    const aliases = await db.select({ id: positions.id, externalIdentity: positions.externalIdentity, url: positions.primaryUrl, status: positions.status }).from(positions);
    existing = aliases.filter(p => (externalIdentity && canonicalExternalIdentity(p.externalIdentity) === externalIdentity)
      || normalizePostingUrl(p.url) === normalizePostingUrl(job.url))
      .sort((a, b) => Number(["applied", "screen", "interview", "offer"].includes(b.status)) - Number(["applied", "screen", "interview", "offer"].includes(a.status)))[0];
  }
  if (existing) {
    await applySnapshot({ positionId: existing.id, job, source: opts.source || "scan" });
    let position = (await getPosition(existing.id))!;
    let revived = false;
    if (opts.reviveArchived && position.status === "archived" && position.listingStatus !== "closed") {
      const next = await patchPosition(position.id, { status: opts.status || "triaged" }, opts.source || "intake");
      if (next) position = next;
      revived = true;
    }
    return { position, created: false, revived };
  }

  if (isNoiseJobTitle(job.title)) {
    ingestQuality.labels({ reason: "junk_title" }).inc();
    log.warn("ingest.rejected", { reason: "junk_title", url: job.url });
    throw new Error("unparseable job title");
  }

  const posId = id("pos");
  const posSlug = `${slugify(`${company.slug}-${job.title}`).slice(0, 70)}-${posId.slice(-4)}`;
  const salary = parseSalary(job.salaryRaw);
  const hash = contentHash({ title: job.title, descriptionText: job.descriptionText, salaryRaw: job.salaryRaw, locationRaw: job.locationRaw });
  const now = new Date();
  const repost = await repostFor({ id: posId, company: company.name, title: job.title, locationRaw: job.locationRaw || null, primaryUrl: job.url, externalIdentity });
  const loc = job.locationRaw || "";
  const facts = classifyListing({
    locationRaw: loc,
    workplaceType: job.workplaceType,
    isRemote: job.isRemote,
    company: company.name,
    title: job.title,
  });
  await db.insert(positions).values({
    id: posId,
    companyId: company.id,
    slug: posSlug,
    title: job.title,
    status: job.listingStatus === "closed" && ["triaged", "review"].includes(opts.status || "triaged") ? "archived" : opts.status || "triaged",
    archiveReason: job.listingStatus === "closed" && ["triaged", "review"].includes(opts.status || "triaged") ? "listing_closed" : null,
    closedAt: job.listingStatus === "closed" ? now : null,
    primaryUrl: job.url,
    atsProvider: job.provider,
    atsJobId: job.jobId,
    atsBoardToken: job.boardToken,
    externalIdentity,
    craftFamily: craftFamily(job.title),
    geoClass: facts.geoClass,
    remoteClass: facts.remoteClass,
    workplace: facts.workplace,
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    salaryRaw: job.salaryRaw || null,
    employmentType: job.employmentType,
    source: opts.source || "scan",
    contentHash: hash,
    listingStatus: job.listingStatus || "unknown",
    firstSeenAt: now,
    lastCheckedAt: now,
    lastChangedAt: now,
    metadata: {
      dataRepairVersion: 1,
      requisitionId: job.requisitionId || requisitionId(job.descriptionText),
      ...(repost ? { repostOfId: repost.id, repost: { id: repost.id, appliedAt: repost.appliedAt?.toISOString() || null, status: repost.status, careerOps: careerStamp(repost), reason: "Possible repost: same employer, title and location as a closed posting" } } : {}),
      ats: {
        provider: job.provider,
        boardToken: job.boardToken,
        jobId: job.jobId,
        applyUrl: job.applyUrl || job.url,
        departments: job.departments || [],
        offices: job.offices || [],
        workplaceType: job.workplaceType || null,
        isRemote: job.isRemote ?? null,
        postedAt: job.postedAt || null,
        questions: (job.questions || []).slice(0, 40),
        fetchedAt: now.toISOString(),
      },
    },
  });
  await db.insert(jdRevisions).values({
    id: id("jdr"),
    positionId: posId,
    revision: 1,
    contentHash: hash,
    changeKind: "first_seen",
    material: true,
    title: job.title,
    locationRaw: job.locationRaw,
    descriptionText: job.descriptionText || "",
    salaryMin: salary.min,
    salaryMax: salary.max,
    salaryCurrency: salary.currency,
    salaryPeriod: salary.period,
    salaryRaw: job.salaryRaw || null,
    remoteClass: facts.remoteClass,
    geoClass: facts.geoClass,
    diffSummary: "first snapshot",
    source: opts.source || "scan",
  });
  await addEvent({ positionId: posId, kind: "created", title: `Created from ${opts.source || "scan"}` });
  if (repost) await addEvent({ positionId: posId, kind: "repost", title: `Possible repost of ${repost.title}`, metadata: { repostOfId: repost.id, appliedAt: repost.appliedAt } });
  const createdPos = (await getPosition(posId))!;
  await afterAtsFetch(posId, job, facts);
  return { position: createdPos, created: true, revived: false };
}

async function afterAtsFetch(positionId: string, job: AtsJob, facts?: ReturnType<typeof classifyListing>) {
  const pos = await getPosition(positionId);
  if (!pos) return;
  const f =
    facts ??
    classifyListing({
      locationRaw: job.locationRaw,
      workplaceType: job.workplaceType,
      isRemote: job.isRemote,
      company: pos.company.name,
      title: job.title || pos.title,
    });
  const db = await getDb();
  const prev = (pos.metadata || {}) as Record<string, unknown>;
  const ats = { ...((prev.ats as Record<string, unknown>) || {}), workplaceType: job.workplaceType ?? null, isRemote: job.isRemote ?? null };
  await db
    .update(positions)
    .set({
      workplace: f.workplace,
      geoClass: f.geoClass,
      remoteClass: f.remoteClass,
      metadata: { ...prev, ats },
      updatedAt: new Date(),
    })
    .where(eq(positions.id, positionId));
  const { harvestFromJob } = await import("./questions.js");
  await harvestFromJob(positionId, job);
  const { maybeEnqueueListingClassify } = await import("./listing-classify.js");
  await maybeEnqueueListingClassify(positionId, f);
}

/** Fetch the ATS page for a position and apply. */
export async function refreshPosition(idOrSlug: string, source = "refresh") {
  const pos = await getPosition(idOrSlug);
  if (!pos) throw new Error("position not found");
  if (!pos.primaryUrl) throw new Error("position has no URL");
  const job = await fetchJobFromUrl(pos.primaryUrl);
  return applySnapshot({ positionId: pos.id, job, source });
}

/** Rows changed since a timestamp — for the career-ops sync skill. */
export async function listChangesSince(since: Date, limit = 200) {
  const db = await getDb();
  const rows = await db
    .select({
      ...LIST_ROW,
      archiveReason: positions.archiveReason,
    })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(gt(positions.updatedAt, since))
    .orderBy(asc(positions.updatedAt))
    .limit(Math.min(500, limit));
  const evals = await db
    .select({ id: evaluations.id, positionId: evaluations.positionId, kind: evaluations.kind, model: evaluations.model, createdAt: evaluations.createdAt })
    .from(evaluations)
    .where(gt(evaluations.createdAt, since))
    .orderBy(asc(evaluations.createdAt))
    .limit(500);
  return { positions: rows, evaluations: evals, now: new Date().toISOString() };
}
