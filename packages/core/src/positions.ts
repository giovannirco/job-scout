import { and, asc, desc, eq, gt, gte, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  applicationMaterials,
  applicationQuestions,
  companies,
  discoveryFeed,
  evaluations,
  getDb,
  id,
  jdRevisions,
  positions,
  slugify,
  type PositionStatus,
} from "@job-scout/db";
import { assertPublicUrl, classifyFetchError, decodeHtmlEntities, detectAts, externalIdentityFromDetect, fetchJobFromUrl as fetchListing, greenhouseListingLocation, type AtsFetchError, type AtsFetchFailure, type AtsJob } from "@job-scout/ats";
import { fetchJob as fetchJobFromUrl } from "./fetch-job.js";
import {
  classifyMateriality,
  contentHash,
  isBadgeBookkeepingDiff,
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
  GeoClass,
  Workplace,
  snapshotIdentityMismatch, snapshotPageVerdict, bodyNotFoundPlausible,
  isNoiseJobTitle, cleanJobTitle, cleanLocation, canonicalExternalIdentity,
  companiesMatch, jdRefreshFrozen, sameNormalizedUrl,
  searchWords, likeContains, homeMarket, listedAtHome,
  employerFromPosting, unresolvedCompany, UNRESOLVED_COMPANY, requisitionId,
  aggregatorHost, extractAggregatorEmployer, decisionTitle,
  isCosmeticTextChange, jdSufficiency, jdSubstantiallyRewritten, type JdSufficiency,
} from "@job-scout/shared";
import { positionSlugFor, slugForRetitle, withPrevious } from "./slug-repair.js";
import { resolveCompanyForName } from "./companies.js";
import { addEvent } from "./timeline.js";
import { hasMaterials, MaterialsMissingError, refreshedCareerOpsStamp } from "./pipeline-integrity.js";
import { jdChanges, watchChecks, ingestQuality } from "./metrics.js";
import { careerStamp, groupingRows, groupRows, groupSummary, repostFor, terminalCareerStatus, validOperatorRow } from "./position-groups.js";
import { getProfile, profileFingerprint } from "./profile.js";
import { decodeCursor, encodeCursor, filterFingerprint } from "./list-cursor.js";
import { applyClassificationOverride, classificationOverride } from "./classification-override.js";

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
  archiveReason: positions.archiveReason,
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
  salaryPeriod: positions.salaryPeriod,
  locationRaw: sql<string | null>`(select jr.location_raw from jd_revisions jr where jr.position_id = ${positions.id} order by jr.revision desc limit 1)`,
  listingStatus: positions.listingStatus,
  watchEnabled: positions.watchEnabled,
  appliedAt: positions.appliedAt,
  firstSeenAt: positions.firstSeenAt,
  postedAt: sql<string | null>`nullif(${positions.metadata}->'ats'->>'postedAt', '')`,
  departments: sql<string[]>`coalesce((select array_agg(value) from jsonb_array_elements_text(coalesce(${positions.metadata}->'ats'->'departments', '[]'::jsonb)) as value), '{}')`,
  lastChangedAt: positions.lastChangedAt,
  triagedAt: positions.triagedAt,
  triageProfileHash: sql<string | null>`${positions.triageJson}->>'profileHash'`,
  repostOfId: sql<string | null>`${positions.metadata}->>'repostOfId'`,
  repost: sql<Record<string, unknown> | null>`${positions.metadata}->'repost'`,
  needsJd: sql<Record<string, unknown> | null>`${positions.metadata}->'needsJd'`,
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
  /** Opaque nextCursor from the previous page (any sort); bound to the sort and filters it was issued for. */
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
  /** "true": only positions waiting for a fuller JD (metadata.needsJd). */
  needsJd?: string;
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
  if (q.needsJd === "true") conds.push(sql`${positions.metadata} ? 'needsJd'`);
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
  const homeOnly = q.geoClass === "home";
  if (homeOnly) conds.push(or(eq(positions.geoClass, "hard_geo"), eq(positions.geoClass, "ambiguous_remote"))!);
  else if (q.geoClass) conds.push(eq(positions.geoClass, q.geoClass));
  if (q.workplace) conds.push(eq(positions.workplace, q.workplace));
  if (q.listingStatus) conds.push(eq(positions.listingStatus, q.listingStatus));
  if (q.minScore) conds.push(gte(positions.triageScore, Number(q.minScore)));
  if (q.watch === "true") conds.push(eq(positions.watchEnabled, true));
  if (q.company) conds.push(or(eq(companies.slug, q.company), eq(companies.id, q.company), ilike(companies.name, `%${q.company}%`))!);
  if (q.q?.trim()) {
    const tokens = searchWords(q.q);
    const terms = tokens.length ? tokens : [q.q.trim()];
    for (const token of terms) {
      const like = likeContains(token);
      conds.push(or(
        ilike(positions.title, like),
        ilike(companies.name, like),
        ilike(positions.slug, like),
        sql`exists (
          select 1 from jd_revisions jr
          where jr.position_id = ${positions.id}
            and jr.revision = (select max(j2.revision) from jd_revisions j2 where j2.position_id = ${positions.id})
            and jr.location_raw ilike ${like}
        )`,
        sql`exists (
          select 1 from jsonb_array_elements_text(coalesce(${positions.metadata}->'ats'->'departments', '[]'::jsonb)) dep
          where dep ilike ${like}
        )`,
      )!);
    }
  }
  const { field, dir } = parseListSort(
    q.sort,
    ["updated", "score", "company", "status", "first_seen", "last_changed", "posted", "title", "workplace", "geo", "location"],
    "updated",
    "desc",
  );
  // Cursor paging works for every sort. updated_* pages by keyset on (updated_at, id), compared at
  // full database precision; the other sorts page by offset over a total order (id breaks ties).
  const sortKey = `${field}_${dir}`;
  const fingerprint = filterFingerprint({ ...q, page: undefined, pageSize: undefined, cursor: undefined, sort: undefined });
  // geoClass=home filters in memory after the query, so it pages by offset to keep `total` whole.
  const keyset = field === "updated" && !homeOnly;
  const cursor = q.cursor ? decodeCursor(q.cursor, { s: sortKey, f: fingerprint }) : null;
  let offset = cursor ? 0 : (page - 1) * pageSize;
  // `where` counts the whole result; `pageWhere` adds the keyset position for this page.
  const where = conds.length ? and(...conds) : undefined;
  let pageWhere = where;
  if (cursor?.k && keyset) {
    const [ts, cid] = cursor.k;
    pageWhere = and(...conds, dir === "asc"
      ? sql`(${positions.updatedAt}, ${positions.id}) > (${ts}::timestamptz, ${cid})`
      : sql`(${positions.updatedAt}, ${positions.id}) < (${ts}::timestamptz, ${cid})`);
  } else if (cursor) offset = cursor.o ?? 0;

  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order =
    field === "score"
      ? [d(sql`coalesce(${positions.triageScore}, -1)`), desc(positions.updatedAt), desc(positions.id)]
      : field === "company"
        ? [d(companies.name), desc(positions.updatedAt), desc(positions.id)]
        : field === "status"
          ? [d(positions.status), desc(positions.updatedAt), desc(positions.id)]
          : field === "first_seen"
            ? [d(positions.firstSeenAt), desc(positions.id)]
            : field === "last_changed"
              ? [d(positions.lastChangedAt), desc(positions.id)]
            : field === "posted"
              ? [
                  dir === "asc"
                    ? sql`nullif(${positions.metadata}->'ats'->>'postedAt', '')::timestamptz ASC NULLS LAST`
                    : sql`nullif(${positions.metadata}->'ats'->>'postedAt', '')::timestamptz DESC NULLS LAST`,
                  desc(positions.id),
                ]
            : field === "title"
              ? [d(positions.title), desc(positions.id)]
              : field === "workplace"
                ? [d(positions.workplace), desc(positions.updatedAt), desc(positions.id)]
                : field === "geo"
                  ? [d(positions.geoClass), desc(positions.updatedAt), desc(positions.id)]
                  : field === "location"
                    ? [
                        d(
                          sql`(select jr.location_raw from jd_revisions jr where jr.position_id = ${positions.id} order by jr.revision desc limit 1)`,
                        ),
                        desc(positions.updatedAt),
                        desc(positions.id),
                      ]
                    : [d(positions.updatedAt), d(positions.id)];

  const query = db
    .select({ ...LIST_ROW, cursorTs: sql<string>`to_json(${positions.updatedAt})#>>'{}'` })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(pageWhere)
    .orderBy(...order)
    .$dynamic();
  // One extra row says whether another page exists.
  const queried = await (homeOnly ? query : query.limit(pageSize + 1).offset(offset));

  let listed = queried;
  let total = 0;
  if (homeOnly) {
    const home = profile.location || "";
    const matched = homeMarket(home) ? queried.filter((row) => listedAtHome(row.geoClass, row.locationRaw, home)) : [];
    total = matched.length;
    listed = matched.slice(offset, offset + pageSize + 1);
  } else {
    total = (
      await db
        .select({ c: sql<number>`count(*)::int` })
        .from(positions)
        .innerJoin(companies, eq(positions.companyId, companies.id))
        .where(where)
    )[0]?.c ?? 0;
  }
  const hasMore = listed.length > pageSize;
  const rows = listed.slice(0, pageSize);
  // cursors[i] resumes right after rows[i], so a caller that keeps only part of a page can continue.
  const cursors = rows.map((row, i) => encodeCursor(keyset
    ? { s: sortKey, f: fingerprint, k: [row.cursorTs, row.id] }
    : { s: sortKey, f: fingerprint, o: offset + i + 1 }));
  const nextCursor = hasMore ? cursors[cursors.length - 1] ?? null : null;
  return { items: rows.map(({ cursorTs: _cursorTs, ...row }) => ({ ...row, ...summaries.get(row.id),
    triageStale: !!row.triagedAt && row.triageProfileHash !== profileHash,
    careerOpsStale: !!row.careerOps?.trackerUpdatedAt && (!row.careerOps.syncedAt || String(row.careerOps.trackerUpdatedAt) > String(row.careerOps.syncedAt)),
  })), page, pageSize, total, nextCursor, cursors };
}

export async function getPosition(idOrSlug: string) {
  const db = await getDb();
  const find = (where: SQL | undefined) => db
    .select({ position: positions, company: companies })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(where)
    .limit(1);
  // Slugs replaced by a repair stay resolvable through metadata.previousSlugs.
  const row = (await find(or(eq(positions.id, idOrSlug), eq(positions.slug, idOrSlug))))[0]
    ?? (await find(sql`jsonb_exists(coalesce(${positions.metadata}->'previousSlugs', '[]'::jsonb), ${idOrSlug})`))[0];
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
      .where(and(eq(applicationQuestions.positionId, pos.id), sql`${applicationQuestions.metadata}->>'droppedAt' is null`)),
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
  "status",
  "priority",
  "resumeSurface",
  "nextAction",
  "notes",
  "watchEnabled",
  "appliedAt",
  "equityNotes",
  "archiveReason",
  "geoNotes",
]);

type PositionRow = NonNullable<Awaited<ReturnType<typeof getPosition>>>;
type EditEvent = { field: string; from: unknown; to: unknown };

/**
 * Listing fields a person corrects by hand: title (reslugged, the old slug kept
 * in metadata.previousSlugs), primaryUrl (public URL guard, ATS identity
 * re-derived as intake does, the old URL kept in metadata.previousUrls so
 * intake still finds the position) and workplace/geoClass (recorded in
 * metadata.classificationOverride, which automatic classification respects).
 */
async function listingEdits(pos: PositionRow, patch: Record<string, unknown>, actor: string) {
  const set: Record<string, unknown> = {};
  const metadata: Record<string, unknown> = { ...(pos.metadata || {}) };
  const events: EditEvent[] = [];
  if (patch.title !== undefined) {
    const title = cleanJobTitle(String(patch.title ?? "")).trim();
    if (!title) throw new Error("invalid_title: title must not be empty");
    if (title.length > 300) throw new Error("invalid_title: title is longer than 300 characters");
    if (title !== pos.title) {
      set.title = title;
      set.craftFamily = craftFamily(title);
      // Only an auto-derived slug follows the title; a hand-picked one stays.
      let slug = slugForRetitle({ id: pos.id, slug: pos.slug, title: pos.title, companySlug: pos.company.slug }, title);
      if (slug) {
        const db = await getDb();
        const taken = (await db.select({ id: positions.id }).from(positions).where(and(eq(positions.slug, slug), sql`${positions.id} <> ${pos.id}`)).limit(1))[0];
        if (taken) slug = `${slug}-${pos.id.slice(-8, -4).toLowerCase()}`;
      }
      if (slug && slug !== pos.slug) {
        set.slug = slug;
        Object.assign(metadata, withPrevious(metadata, pos.slug));
      }
      events.push({ field: "title", from: pos.title, to: title });
    }
  }
  if (patch.primaryUrl !== undefined) {
    const raw = String(patch.primaryUrl ?? "").trim();
    let url: string;
    try {
      url = assertPublicUrl(raw).toString();
    } catch (e) {
      throw new Error(`invalid_url: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (isPlaceholderAtsUrl(url)) throw new Error("invalid_url: placeholder or invalid posting URL");
    if (url !== pos.primaryUrl) {
      const detected = detectAts(url);
      const externalIdentity = canonicalExternalIdentity(externalIdentityFromDetect(detected)) || null;
      const db = await getDb();
      const others = await db.select({ id: positions.id, slug: positions.slug, url: positions.primaryUrl, externalIdentity: positions.externalIdentity }).from(positions).where(sql`${positions.id} <> ${pos.id}`);
      const clash = others.find((o) => o.url === url || sameNormalizedUrl(o.url, url)
        || (externalIdentity && canonicalExternalIdentity(o.externalIdentity) === externalIdentity));
      if (clash) throw new Error(`url_conflict: ${url} already belongs to position ${clash.slug}`);
      set.primaryUrl = url;
      set.atsProvider = detected.provider === "unknown" ? "other" : detected.provider;
      set.atsJobId = detected.jobId ?? null;
      set.atsBoardToken = detected.boardToken ?? null;
      set.externalIdentity = externalIdentity;
      const prev = Array.isArray(metadata.previousUrls) ? metadata.previousUrls.filter((u): u is string => typeof u === "string") : [];
      if (pos.primaryUrl) metadata.previousUrls = [...new Set([...prev, pos.primaryUrl])].filter((u) => u !== url);
      events.push({ field: "primaryUrl", from: pos.primaryUrl, to: url });
    }
  }
  const override = { ...classificationOverride(metadata) };
  let overridden = false;
  for (const [field, schema] of [["workplace", Workplace], ["geoClass", GeoClass]] as const) {
    if (patch[field] === undefined) continue;
    const parsed = schema.safeParse(patch[field]);
    if (!parsed.success) throw new Error(`invalid_${field}: must be ${schema.options.join("|")}`);
    // Recorded even when the value already matches, so later classification keeps it.
    override[field] = parsed.data as never;
    overridden = true;
    if (parsed.data !== pos[field]) {
      set[field] = parsed.data;
      events.push({ field, from: pos[field], to: parsed.data });
    }
  }
  if (overridden) metadata.classificationOverride = { ...override, actor, at: new Date().toISOString() };
  const touched = Object.keys(set).length > 0 || overridden;
  return { set: touched ? { ...set, metadata } : {}, events };
}

export async function patchPosition(idOrSlug: string, patch: Record<string, unknown>, actor = "operator") {
  const db = await getDb();
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  const edits = await listingEdits(pos, patch, actor);
  const set: Record<string, unknown> = { updatedAt: new Date(), ...edits.set };
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k)) continue;
    if (k === "status") {
      const s = PipelineStatus.safeParse(v);
      if (!s.success) throw new Error(`invalid status ${String(v)}`);
      // `materials` is a fact about files, not an intent: drafts land first (runMaterials moves the stage).
      if (s.data === "materials" && pos.status !== "materials" && !(await hasMaterials(pos.id, pos.metadata))) throw new MaterialsMissingError(pos.id);
      set.status = s.data;
      if (s.data === "applied" && !pos.appliedAt) set.appliedAt = new Date();
      if (s.data !== "archived") set.archiveReason = null;
    } else if (k === "appliedAt") set.appliedAt = v ? new Date(String(v)) : null;
    else set[k] = v;
  }
  if (patch.metadata && typeof patch.metadata === "object") {
    set.metadata = { ...((set.metadata as Record<string, unknown> | undefined) || pos.metadata || {}), ...(patch.metadata as object) };
  }
  // "<agent> via <token>" (MCP caller attribution) is automated when its token is.
  const via = actor.lastIndexOf(" via ");
  const principal = via >= 0 ? actor.slice(via + 5) : actor;
  const automated = /^(system|autopilot|career-ops|intake|scan(?::.*)?|triage|evaluate|import|seed)$/.test(principal);
  let reslugged: { from: string; to: string } | null = null;
  if (typeof set.title === "string") {
    const title = cleanJobTitle(set.title);
    if (!title) throw new Error("title cannot be empty");
    set.title = title;
    if (title !== pos.title) {
      const metadata = { ...(pos.metadata || {}), ...((set.metadata || {}) as Record<string, unknown>) };
      // A person's title survives ATS refreshes; an automated fill does not pin it.
      if (!automated) metadata.titleOverride = { title, actor, at: new Date().toISOString() };
      // listingEdits already moved an auto-derived slug.
      if (typeof set.slug === "string" && set.slug !== pos.slug) reslugged = { from: pos.slug, to: set.slug };
      set.craftFamily = craftFamily(title);
      set.metadata = metadata;
    } else delete set.title;
  }
  if (set.status) {
    const metadata = { ...(pos.metadata || {}), ...((set.metadata || {}) as Record<string, unknown>) };
    if (set.status === "review" && !automated) metadata.reviewIntent = { kind: "operator", actor, at: new Date().toISOString() };
    else delete metadata.reviewIntent;
    if (set.status !== pos.status) {
      const stamp = refreshedCareerOpsStamp(metadata.careerOps as Record<string, unknown> | undefined, String(set.status));
      if (stamp) metadata.careerOps = stamp;
    }
    set.metadata = metadata;
  }
  await db.update(positions).set(set).where(eq(positions.id, pos.id));
  for (const e of edits.events) {
    await addEvent({ positionId: pos.id, kind: "edit", title: `${e.field}: ${String(e.from ?? "∅")} → ${String(e.to ?? "∅")}`.slice(0, 300), actor, metadata: { field: e.field, from: e.from ?? null, to: e.to ?? null } });
  }
  if (reslugged) await addEvent({ positionId: pos.id, kind: "repair", title: `Slug follows title: ${reslugged.from} → ${reslugged.to}`, actor, metadata: reslugged });
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

function archivedStamp(metadata: Record<string, unknown> | null | undefined) {
  const stamp = refreshedCareerOpsStamp(metadata?.careerOps as Record<string, unknown> | undefined, "archived");
  return stamp ? { metadata: { ...(metadata || {}), careerOps: stamp } } : {};
}

export async function archivePosition(idOrSlug: string, reason: string, actor = "operator") {
  const db = await getDb();
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  await db
    .update(positions)
    .set({ status: "archived", archiveReason: reason.slice(0, 300), watchEnabled: false, updatedAt: new Date(), ...archivedStamp(pos.metadata) })
    .where(eq(positions.id, pos.id));
  await addEvent({ positionId: pos.id, kind: "status", title: `archived: ${reason}`, actor });
  return getPosition(pos.id);
}

/** Merge a career-ops stamp into metadata.careerOps (id, score, status, paths). */
export async function stampCareerOps(idOrSlug: string, stamp: Record<string, unknown>) {
  const db = await getDb();
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  const now = new Date().toISOString();
  // Record job-scout's own stage at stamp time so a later status change shows as drift.
  const next = { ...stamp, syncedAt: now, jsStatus: pos.status, jsStatusAt: now };
  // The stamp is the sync's own echo: it leaves updatedAt alone so list_changes does not hand it back.
  const [updated] = await db
    .update(positions)
    .set({ metadata: sql`jsonb_set(coalesce(${positions.metadata}, '{}'::jsonb), '{careerOps}', coalesce(${positions.metadata}->'careerOps', '{}'::jsonb) || ${JSON.stringify(next)}::jsonb)` })
    .where(eq(positions.id, pos.id)).returning();
  const meta = (updated?.metadata || {}) as Record<string, unknown>;
  return meta.careerOps;
}

/** The title a person set by hand, which ATS refreshes must not replace. */
function titleOverrideOf(metadata: Record<string, unknown> | null | undefined): string | null {
  const o = metadata?.titleOverride as { title?: unknown } | undefined;
  return o && typeof o.title === "string" && o.title.trim() ? o.title : null;
}

/** metadata.needsJd for an insufficient JD (keeps the original `since`); {} when the JD is enough. */
function needsJdPatch(metadata: Record<string, unknown> | null | undefined, jd: JdSufficiency, revision: number): Record<string, unknown> {
  if (jd.sufficient) return {};
  const prev = metadata?.needsJd as { since?: string } | undefined;
  return { needsJd: { since: prev?.since || new Date().toISOString(), reason: jd.reason, words: jd.words, revision } };
}

/**
 * The JD the position was scored on is gone (a title-only JD was replaced, the
 * role retitled, the body rewritten): mark evaluations superseded and queue a
 * forced re-triage. A passing triage re-queues evaluate through autopilot.
 * Only triaged/review positions: a live process keeps its scores.
 */
export async function requeueScoring(positionId: string, opts: { revision: number; reason: string }) {
  const pos = await getPosition(positionId);
  if (!pos || !["triaged", "review"].includes(pos.status) || pos.listingStatus === "closed" || pos.metadata?.quarantined) return { skipped: true as const };
  const db = await getDb();
  const now = new Date().toISOString();
  const evs = await db.select({ id: evaluations.id, kind: evaluations.kind, json: evaluations.json }).from(evaluations)
    .where(and(eq(evaluations.positionId, pos.id), inArray(evaluations.kind, ["evaluate", "jd_review"])));
  const stale = evs.filter((e) => !(e.json as { superseded?: unknown } | null)?.superseded);
  for (const e of stale) {
    await db.update(evaluations).set({ json: { ...(e.json || {}), superseded: { at: now, reason: opts.reason, byRevision: opts.revision } } }).where(eq(evaluations.id, e.id));
  }
  const { enqueueJob } = await import("./jobs.js");
  const triage = await enqueueJob("triage", { positionId: pos.id, force: true, reason: opts.reason }, { dedupeKey: `triage:${pos.id}`, priority: 30 });
  await addEvent({
    positionId: pos.id,
    kind: "harness",
    title: `Re-scoring queued: ${opts.reason.replace(/_/g, " ")}`,
    body: stale.length ? `Superseded ${stale.length} evaluation(s) scored on the earlier JD.` : undefined,
    metadata: { reason: opts.reason, revision: opts.revision, superseded: stale.map((e) => e.id), triageJobId: triage.id },
  });
  return { skipped: false as const, superseded: stale.map((e) => e.id), triageJobId: triage.id };
}

/**
 * Apply a fresh ATS snapshot to an existing position. Writes a jd_revision only
 * when content/title/comp/status actually changed. A closed listing gets exactly
 * one `closed` revision.
 */
/**
 * `force` is an explicit operator refresh: it overrides the interview/offer freeze and
 * watchEnabled=false, never the not-a-JD, failed-fetch or identity guards.
 */
export async function applySnapshot(opts: { positionId: string; job: AtsJob; source?: string; force?: boolean }) {
  const db = await getDb();
  const pos = await getPosition(opts.positionId);
  if (!pos) throw new Error("position not found");

  // A soft-404 / "Job Not Found" page is a closure signal, never content: keep title + JD.
  // Page text alone is weak evidence (a CDN hiccup, an A/B shell), so it closes the listing
  // only on a second consecutive soft-404 at least SOFT_404_CONFIRM_MS after the first.
  // HTTP 404/410 (listingStatus already "closed" from the fetcher) still closes at once.
  let prevBody: string | null = null;
  if (opts.job.listingStatus !== "closed") {
    prevBody = (await db.select({ d: jdRevisions.descriptionText }).from(jdRevisions).where(eq(jdRevisions.positionId, pos.id)).orderBy(desc(jdRevisions.revision)).limit(1))[0]?.d ?? null;
  }
  const page = opts.job.listingStatus === "closed" ? null : snapshotPageVerdict(pos.title, opts.job, { prevBody });
  let softNotFoundSince: string | undefined;
  if (page?.refuse && page.signature === "not_found") {
    const streak = softNotFoundStreak(pos.metadata);
    softNotFoundSince = streak ?? new Date().toISOString();
    // A not-found title over a full-length JD body is a refusal, never a closure.
    if (streak && Date.now() - Date.parse(streak) >= SOFT_404_CONFIRM_MS && bodyNotFoundPlausible(prevBody, opts.job.descriptionText)) {
      log.warn("jd.snapshot_not_found", { positionId: pos.id, where: page.where, url: opts.job.url, since: streak });
      opts = { ...opts, job: { ...opts.job, listingStatus: "closed", title: "", descriptionText: "", locationRaw: undefined, salaryRaw: pos.salaryRaw || undefined, rawPayload: { ...(opts.job.rawPayload || {}), closedReason: "not_found_page", softNotFoundSince: streak } } };
      softNotFoundSince = undefined;
    }
  }
  const blocked = snapshotBlockReason(pos, opts.job, { prevBody, source: opts.source || "scan", force: Boolean(opts.force) });
  if (blocked) {
    // Keep the last good revision: no jd_revision, no jd_change, no re-scoring. Record why.
    // Nothing the operator sees changed, so updatedAt (what list_changes reads) stays put.
    const now = new Date();
    await db
      .update(positions)
      .set({
        lastCheckedAt: now,
        metadata: {
          ...(pos.metadata || {}),
          lastAtsFetch: { at: now.toISOString(), provider: opts.job.provider, listingStatus: opts.job.listingStatus, rejected: blocked, ...fetchFailureOf(opts.job), ...(softNotFoundSince ? { softNotFoundSince } : {}) },
        },
      })
      .where(eq(positions.id, pos.id));
    // A policy refusal (frozen stage, watch off) repeats on every scan/watch tick: log it once per run.
    const policy = /^(frozen:|watch_disabled$)/.test(blocked);
    const prevRejected = (pos.metadata?.lastAtsFetch as { rejected?: unknown } | undefined)?.rejected;
    if (!policy || prevRejected !== blocked) await addEvent({
      positionId: pos.id,
      kind: "harness",
      title: `JD snapshot not applied: ${blocked}`.slice(0, 300),
      body: `source=${opts.source || "scan"} url=${opts.job.url || ""} title=${(opts.job.title || "").slice(0, 120)} company=${opts.job.company || ""}`,
      metadata: { reason: blocked, source: opts.source || "scan", incoming: { url: opts.job.url, title: opts.job.title, company: opts.job.company, provider: opts.job.provider, jobId: opts.job.jobId, externalIdentity: opts.job.externalIdentity } },
    });
    watchChecks.labels({ outcome: "rejected" }).inc();
    log.warn("jd.snapshot_rejected", { positionId: pos.id, reason: blocked, source: opts.source || "scan", url: opts.job.url });
    return { changed: false as const, revision: null, rejected: blocked };
  }

  // The posting's own title (recorded on the revision) and the position's title, which
  // follows it unless a person set the title by hand (metadata.titleOverride).
  const atsTitle = preferJobTitle(isNoiseJobTitle(opts.job.title) ? "" : opts.job.title, pos.title, { slug: pos.slug, companySlug: pos.company.slug });
  const titleOverride = titleOverrideOf(pos.metadata);
  const title = titleOverride ? pos.title : atsTitle;
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

  // An unchanged check records lastCheckedAt only; updatedAt (what list_changes reads) moves
  // only when a field the operator sees actually changes.
  const touch = async (extra: Record<string, unknown> = {}) => {
    const visible = Object.entries(extra).some(([k, v]) => k !== "contentHash" && (pos as Record<string, unknown>)[k] !== v);
    await db
      .update(positions)
      .set({
        lastCheckedAt: now,
        ...(visible ? { updatedAt: now } : {}),
        metadata: {
          ...(pos.metadata || {}),
          lastAtsFetch: { at: now.toISOString(), provider: opts.job.provider, listingStatus: opts.job.listingStatus, ...fetchFailureOf(opts.job) },
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
    title: atsTitle,
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
    title: atsTitle,
    location_raw: locationRaw || before.location_raw,
    salary_raw: salaryRaw ?? "",
    description_text: bodyText,
    listing_status: observedStatus,
  };
  const diffs = fieldDiffs(before, after, ["title", "location_raw", "salary_raw", "description_text", "listing_status"]).filter(
    (d) => !(d.path === "title" && isShellJobTitle(String(d.after ?? "")) && !isShellJobTitle(String(d.before ?? ""))) && !isBadgeBookkeepingDiff(d)
      // Whitespace, tracking params, page date stamps, reordered blocks: not a new revision.
      && !(d.path === "description_text" && isCosmeticTextChange(d.before, d.after)),
  );
  if (!diffs.length && nextRev > 1) {
    await touch({
      contentHash: hash,
      ...(pos.listingStatus === "changed" && !listingClosed ? { listingStatus: "open" } : {}),
    });
    watchChecks.labels({ outcome: "unchanged" }).inc();
    return { changed: false as const, revision: null };
  }
  const { material, change_kind } = classifyMateriality(diffs, {
    forceKind: nextRev === 1 ? "first_seen" : listingClosed ? "closed" : undefined,
  });
  const loc = locationRaw || before.location_raw;
  const computed = classifyListing({
    locationRaw: loc,
    workplaceType: opts.job.workplaceType,
    isRemote: opts.job.isRemote,
    company: pos.company.name,
    title,
    descriptionText: bodyText,
  });
  // The revision records what the listing says; the position keeps a person's workplace/geo call.
  const facts = applyClassificationOverride(pos.metadata, computed);

  await db.insert(jdRevisions).values({
    id: id("jdr"),
    positionId: pos.id,
    revision: nextRev,
    observedAt: now,
    contentHash: hash,
    changeKind: change_kind,
    material,
    title: atsTitle,
    locationRaw: loc || null,
    descriptionText: bodyText,
    salaryMin: salary.min ?? pos.salaryMin,
    salaryMax: salary.max ?? pos.salaryMax,
    salaryCurrency: salary.currency || pos.salaryCurrency,
    salaryPeriod: salary.period || pos.salaryPeriod,
    salaryRaw,
    remoteClass: computed.remoteClass,
    geoClass: computed.geoClass,
    diffSummary: nextRev === 1 ? "first snapshot" : summarizeDiffs(diffs),
    fieldDiffs: diffs,
    source: opts.source || "scan",
  });

  const listingStatus = listingClosed ? "closed" : observedStatus === "open" ? (material && pos.listingStatus !== "closed" ? "changed" : "open") : pos.listingStatus || "unknown";
  // Enough JD to score? A closure keeps whatever flag the open listing had.
  const prevJd = jdSufficiency(before.title, before.description_text);
  const jd = listingClosed ? prevJd : jdSufficiency(atsTitle, bodyText);
  const jdArrived = !listingClosed && nextRev > 1 && !prevJd.sufficient && jd.sufficient;
  const retitled = title !== pos.title && Boolean(pos.title.trim());
  const nextSlug = retitled ? slugForRetitle({ id: pos.id, slug: pos.slug, title: pos.title, companySlug: pos.company.slug }, title, [prevRev?.title]) : null;
  const metadata: Record<string, unknown> = {
    ...(nextSlug ? withPrevious(pos.metadata, pos.slug) : pos.metadata || {}),
    ...needsJdPatch(pos.metadata, jd, nextRev),
  };
  if (jd.sufficient) delete metadata.needsJd;
  await db
    .update(positions)
    .set({
      title,
      ...(nextSlug ? { slug: nextSlug } : {}),
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
      lastChangedAt: material && change_kind !== "first_seen" ? now : (pos.lastChangedAt || now),
      closedAt: listingStatus === "closed" ? pos.closedAt || now : null,
      firstSeenAt: pos.firstSeenAt || now,
      metadata: {
        ...metadata,
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
        lastAtsFetch: { at: now.toISOString(), provider: opts.job.provider, listingStatus: opts.job.listingStatus, ...fetchFailureOf(opts.job) },
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
  if (nextSlug) {
    await addEvent({ positionId: pos.id, kind: "repair", title: `Slug follows title: ${pos.slug} → ${nextSlug}`, actor: "system", metadata: { from: pos.slug, to: nextSlug } });
  }
  if (titleOverride && atsTitle !== titleOverride && prevRev?.title !== atsTitle) {
    await addEvent({ positionId: pos.id, kind: "harness", title: "Posting retitled; kept the title set by hand", body: `posting: ${atsTitle.slice(0, 200)}; kept: ${pos.title.slice(0, 200)}` });
  }
  if (!jd.sufficient && !listingClosed && (prevJd.sufficient || nextRev === 1)) {
    await addEvent({ positionId: pos.id, kind: "harness", title: "Needs JD: too little description to score", body: `${jd.words} words beyond the title (${jd.reason}). Triage, evaluation and research wait for a fuller JD.` });
  }
  await afterAtsFetch(pos.id, opts.job, facts);
  if (jd.sufficient && (nextRev === 1 || material || jdArrived)) {
    const { enqueuePositionDecision } = await import("./decision-events.js");
    await enqueuePositionDecision(pos.id, nextRev, { changeKind: jdArrived ? "jd_arrived" : change_kind });
  }
  // Earlier scoring described a different JD: the real one arrived, the role was
  // retitled, or the body was rewritten. Re-triage and supersede the evaluation.
  const rewritten = material && nextRev > 1 && change_kind === "content" && jdSubstantiallyRewritten(before.description_text, bodyText);
  if (jd.sufficient && (jdArrived || (material && nextRev > 1 && change_kind === "title") || rewritten)) {
    await requeueScoring(pos.id, { revision: nextRev, reason: jdArrived ? "jd_arrived" : change_kind === "title" ? "retitled" : "jd_rewritten" });
  }
  if (material && nextRev > 1 && jd.sufficient) {
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

/** Greenhouse leaves `&mdash;` in the stored JD. Rewrite the latest snapshot in place. */
export async function decodeStoredJdEntities(): Promise<{ updated: number }> {
  const db = await getDb();
  const candidates = await db
    .select({ positionId: jdRevisions.positionId })
    .from(jdRevisions)
    .where(sql`${jdRevisions.descriptionText} ~ '&(mdash|ndash|hellip|rsquo|lsquo|rdquo|ldquo);'`);
  const ids = [...new Set(candidates.map((row) => row.positionId))];
  let updated = 0;
  for (const positionId of ids) {
    const rev = (
      await db
        .select({
          id: jdRevisions.id,
          descriptionText: jdRevisions.descriptionText,
          title: jdRevisions.title,
          salaryRaw: jdRevisions.salaryRaw,
          locationRaw: jdRevisions.locationRaw,
        })
        .from(jdRevisions)
        .where(eq(jdRevisions.positionId, positionId))
        .orderBy(desc(jdRevisions.revision))
        .limit(1)
    )[0];
    if (!rev?.descriptionText) continue;
    const next = decodeHtmlEntities(rev.descriptionText);
    if (next === rev.descriptionText) continue;
    const hash = contentHash({ title: rev.title, descriptionText: next, salaryRaw: rev.salaryRaw, locationRaw: rev.locationRaw });
    await db.update(jdRevisions).set({ descriptionText: next, contentHash: hash }).where(eq(jdRevisions.id, rev.id));
    await db
      .update(positions)
      .set({ contentHash: hash })
      .where(eq(positions.id, positionId));
    updated++;
  }
  return { updated };
}

/** A snapshot we completed ourselves is not an employer edit, so it should not move Changed. */
export async function repairSnapshotChangeTimes(): Promise<{ updated: number }> {
  const db = await getDb();
  const rows = await db
    .select({ id: positions.id, firstSeenAt: positions.firstSeenAt, lastChangedAt: positions.lastChangedAt })
    .from(positions);
  let updated = 0;
  for (const row of rows) {
    if (!row.firstSeenAt || !row.lastChangedAt) continue;
    if (row.lastChangedAt.getTime() - row.firstSeenAt.getTime() < 60_000) continue;
    const revs = await db
      .select({
        id: jdRevisions.id,
        revision: jdRevisions.revision,
        observedAt: jdRevisions.observedAt,
        fieldDiffs: jdRevisions.fieldDiffs,
        material: jdRevisions.material,
        changeKind: jdRevisions.changeKind,
      })
      .from(jdRevisions)
      .where(eq(jdRevisions.positionId, row.id))
      .orderBy(asc(jdRevisions.revision));
    let latest: Date | null = null;
    for (const rev of revs) {
      if (rev.revision <= 1) continue;
      const diffs = Array.isArray(rev.fieldDiffs) ? rev.fieldDiffs : [];
      const judged = diffs.length ? classifyMateriality(diffs) : { material: rev.material, change_kind: rev.changeKind };
      if (diffs.length && (judged.material !== rev.material || judged.change_kind !== rev.changeKind)) {
        await db.update(jdRevisions).set({ material: judged.material, changeKind: judged.change_kind }).where(eq(jdRevisions.id, rev.id));
      }
      if (judged.material && judged.change_kind !== "first_seen" && judged.change_kind !== "noise_rebase") latest = rev.observedAt;
    }
    const next = latest || row.firstSeenAt;
    if (Math.abs(next.getTime() - row.lastChangedAt.getTime()) < 1000) continue;
    await db.update(positions).set({ lastChangedAt: next }).where(eq(positions.id, row.id));
    updated++;
  }
  return { updated };
}

/** Drop "changed" when every later revision only completed a bad first snapshot. */
export async function clearRepairedChangedBadges(): Promise<{ cleared: number }> {
  const db = await getDb();
  const rows = await db.select({ id: positions.id }).from(positions).where(eq(positions.listingStatus, "changed"));
  let cleared = 0;
  for (const row of rows) {
    const revs = await db
      .select({ revision: jdRevisions.revision, fieldDiffs: jdRevisions.fieldDiffs })
      .from(jdRevisions)
      .where(eq(jdRevisions.positionId, row.id));
    const genuine = revs.some((rev) => rev.revision > 1 && classifyMateriality(rev.fieldDiffs || []).material);
    if (genuine) continue;
    await db.update(positions).set({ listingStatus: "open", updatedAt: new Date() }).where(eq(positions.id, row.id));
    cleared++;
  }
  return { cleared };
}

/** Replace `USD [object Object]–150000` with the range the posting actually named. */
export async function repairObjectSalaries(): Promise<{ checked: number; updated: number; failed: number; failedIds: string[] }> {
  const db = await getDb();
  const rows = await db
    .select({ id: positions.id, url: positions.primaryUrl, title: positions.title })
    .from(positions)
    .where(sql`${positions.salaryRaw} ilike '%[object Object]%' or exists (
      select 1 from jd_revisions jr
      where jr.position_id = ${positions.id}
        and jr.salary_raw ilike '%[object Object]%'
        and jr.revision = (select max(j2.revision) from jd_revisions j2 where j2.position_id = ${positions.id})
    )`);
  let updated = 0;
  let failed = 0;
  const failedIds: string[] = [];
  for (const row of rows) {
    if (!row.url) {
      failed++;
      failedIds.push(row.id);
      continue;
    }
    try {
      const job = await fetchListing(row.url);
      const salaryRaw = (job.salaryRaw || "").trim();
      if (!salaryRaw || /\[object Object\]/.test(salaryRaw)) {
        failed++;
      failedIds.push(row.id);
        continue;
      }
      const salary = parseSalary(salaryRaw);
      if (salary.min == null) {
        failed++;
      failedIds.push(row.id);
        continue;
      }
      const prev = (
        await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, row.id)).orderBy(desc(jdRevisions.revision)).limit(1)
      )[0];
      const hash = contentHash({
        title: row.title,
        descriptionText: prev?.descriptionText || "",
        salaryRaw,
        locationRaw: prev?.locationRaw || "",
      });
      await db.update(positions).set({
        salaryMin: salary.min,
        salaryMax: salary.max,
        salaryCurrency: salary.currency,
        salaryPeriod: salary.period,
        salaryRaw,
        contentHash: hash,
      }).where(eq(positions.id, row.id));
      if (prev) {
        await db.update(jdRevisions).set({
          salaryMin: salary.min,
          salaryMax: salary.max,
          salaryCurrency: salary.currency,
          salaryPeriod: salary.period,
          salaryRaw,
          contentHash: hash,
        }).where(eq(jdRevisions.id, prev.id));
      }
      updated++;
    } catch (e) {
      failed++;
      failedIds.push(row.id);
      log.warn("salary.object_repair_failed", { url: row.url, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checked: rows.length, updated, failed, failedIds };
}

/** Minimum gap between the first and the confirming soft-404 observation. */
export const SOFT_404_CONFIRM_MS = 30 * 60_000;

/** When the current run of soft-404 observations began (the previous fetch was one), else null. */
function softNotFoundStreak(metadata: Record<string, unknown> | null | undefined): string | null {
  const last = (metadata?.lastAtsFetch || null) as { at?: unknown; rejected?: unknown; softNotFoundSince?: unknown } | null;
  if (!last || typeof last.rejected !== "string" || !last.rejected.startsWith("not_a_jd:not_found")) return null;
  const since = typeof last.softNotFoundSince === "string" ? last.softNotFoundSince : typeof last.at === "string" ? last.at : null;
  return since && Number.isFinite(Date.parse(since)) ? since : null;
}

/**
 * Why a fetched posting must NOT be applied to this position (null = apply):
 *  - not a JD: JS wall, loading shell, placeholder or vendor boilerplate
 *  - failed fetch flagged by the fetcher (e.g. InHire job id mismatch)
 *  - identity: a different company or ATS posting (cross-company clobber)
 *  - frozen: interview stage or later keeps the JD it was interviewed on (closure still applies)
 *  - watch off: an automatic watch never rewrites a non-hot position with watchEnabled=false;
 *    it only records closure
 * `force` (explicit operator refresh) lifts only the last two.
 */
export function snapshotBlockReason(
  pos: { title?: string | null; status?: string | null; watchEnabled?: boolean | null; primaryUrl?: string | null; atsProvider?: string | null; atsJobId?: string | null; externalIdentity?: string | null; company: { name: string } },
  job: AtsJob,
  opts: { prevBody?: string | null; source?: string; force?: boolean } = {},
): string | null {
  if (job.listingStatus !== "closed") {
    const page = snapshotPageVerdict(pos.title, job, opts);
    if (page.refuse) return `not_a_jd:${page.signature}:${page.where}`;
  }
  const failed = (job.rawPayload as { fetchFailed?: string } | undefined)?.fetchFailed;
  if (failed) return `failed_fetch:${failed}`;
  const mismatch = snapshotIdentityMismatch(
    { companyName: pos.company.name, primaryUrl: pos.primaryUrl, atsProvider: pos.atsProvider, atsJobId: pos.atsJobId, externalIdentity: pos.externalIdentity },
    { company: job.company, url: job.url, provider: job.provider, jobId: job.jobId, externalIdentity: job.externalIdentity },
  );
  if (mismatch) return `identity_mismatch:${mismatch}`;
  if (opts.force || job.listingStatus === "closed") return null;
  if (jdRefreshFrozen(pos.status)) return `frozen:${pos.status}`;
  if (opts.source === "watch" && pos.watchEnabled === false && !(HOT_STATUSES as readonly string[]).includes(String(pos.status || ""))) return "watch_disabled";
  return null;
}

/** Create-or-update a position from an ATS job. New positions start as `triaged` (untriaged until the LLM runs). */
export async function trimStoredTitles(): Promise<{ updated: number }> {
  const db = await getDb();
  let updated = 0;
  const posRows = await db.select({ id: positions.id, title: positions.title }).from(positions);
  for (const row of posRows) {
    const title = cleanJobTitle(row.title);
    if (!title || title === row.title) continue;
    await db.update(positions).set({ title, updatedAt: new Date() }).where(eq(positions.id, row.id));
    updated++;
  }
  const feedRows = await db.select({ id: discoveryFeed.id, title: discoveryFeed.title }).from(discoveryFeed);
  for (const row of feedRows) {
    const title = cleanJobTitle(row.title);
    if (!title || title === row.title) continue;
    await db.update(discoveryFeed).set({ title }).where(eq(discoveryFeed.id, row.id));
    updated++;
  }
  return { updated };
}

export async function upsertFromJob(
  job: AtsJob,
  opts: { status?: PositionStatus; source?: string; companyName?: string; reviveArchived?: boolean } = {},
): Promise<{ position: NonNullable<Awaited<ReturnType<typeof getPosition>>>; created: boolean; revived: boolean }> {
  job = { ...job, title: cleanJobTitle(job.title) };
  const db = await getDb();
  if (!job.url?.trim() || isPlaceholderAtsUrl(job.url)) {
    ingestQuality.labels({ reason: "placeholder_url" }).inc();
    log.warn("ingest.rejected", { reason: "placeholder_url", url: job.url });
    throw new Error("placeholder or invalid posting URL");
  }
  job = { ...job, locationRaw: cleanLocation(job.locationRaw) };
  const aggregator = aggregatorHost(job.url);
  let companyName = [opts.companyName, job.company, job.boardToken].find(n => !unresolvedCompany(n))
    || employerFromPosting(job.url, job.title) || UNRESOLVED_COMPANY;
  let employerVia: string | null = null;
  if (aggregator && companyName === UNRESOLVED_COMPANY) {
    // The aggregator hides or replaces the employer: look for it on the page itself.
    const raw = (job.rawPayload || {}) as { htmlExcerpt?: unknown; titleCandidates?: unknown; jsonLd?: { company?: unknown } | null };
    const found = extractAggregatorEmployer({
      html: typeof raw.htmlExcerpt === "string" ? raw.htmlExcerpt : null,
      title: job.title,
      titleCandidates: Array.isArray(raw.titleCandidates) ? raw.titleCandidates.filter((t): t is string => typeof t === "string") : null,
      text: job.descriptionText,
      jsonLdCompany: typeof raw.jsonLd?.company === "string" ? raw.jsonLd.company : null,
    });
    if (found) {
      companyName = found.company;
      employerVia = found.via;
    }
  }
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
    // An alias must be the same employer, and two unparseable URLs ("" === "") are not a match.
    const aliases = await db
      .select({ id: positions.id, externalIdentity: positions.externalIdentity, url: positions.primaryUrl, status: positions.status, companyName: companies.name })
      .from(positions)
      .innerJoin(companies, eq(positions.companyId, companies.id));
    existing = aliases.filter(p => companiesMatch(p.companyName, company.name)
      && ((externalIdentity && canonicalExternalIdentity(p.externalIdentity) === externalIdentity) || sameNormalizedUrl(p.url, job.url)))
      .sort((a, b) => Number(["applied", "screen", "interview", "offer"].includes(b.status)) - Number(["applied", "screen", "interview", "offer"].includes(a.status)))[0];
  }
  if (existing) {
    await applySnapshot({ positionId: existing.id, job: { ...job, company: job.company || company.name }, source: opts.source || "scan" });
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

  // An aggregator repost of a role already filed at the same employer is an alias of that
  // filing, not a new decision. An aggregator row with no employer is held from autopilot.
  const aliasOf = aggregator && companyName !== UNRESOLVED_COMPANY ? await aggregatorOriginal(company.id, job.title) : null;
  const aggregatorMeta = aggregator
    ? {
        host: aggregator,
        unresolved: companyName === UNRESOLVED_COMPANY,
        employer: companyName === UNRESOLVED_COMPANY ? null : company.name,
        via: employerVia ?? (companyName === UNRESOLVED_COMPANY ? null : "listing"),
        ...(aliasOf ? { duplicateOfId: aliasOf.id } : {}),
      }
    : null;
  if (aggregatorMeta?.unresolved) ingestQuality.labels({ reason: "aggregator_unresolved" }).inc();
  if (aliasOf) ingestQuality.labels({ reason: "aggregator_duplicate" }).inc();

  const hash = contentHash({ title: job.title, descriptionText: job.descriptionText, salaryRaw: job.salaryRaw, locationRaw: job.locationRaw });
  const jd = jdSufficiency(job.title, job.descriptionText);
  // Posting identity comes from the ATS id or canonical URL, never JD text.
  // Identical descriptions are grouped for display without discarding their links.

  const posId = id("pos");
  const posSlug = `${slugify(`${company.slug}-${job.title}`).slice(0, 70)}-${posId.slice(-4)}`;
  const salary = parseSalary(job.salaryRaw);
  const now = new Date();
  const repost = await repostFor({ id: posId, company: company.name, title: job.title, locationRaw: job.locationRaw || null, primaryUrl: job.url, externalIdentity });
  const loc = job.locationRaw || "";
  const facts = classifyListing({
    locationRaw: loc,
    workplaceType: job.workplaceType,
    isRemote: job.isRemote,
    company: company.name,
    title: job.title,
    descriptionText: job.descriptionText,
  });
  await db.insert(positions).values({
    id: posId,
    companyId: company.id,
    slug: posSlug,
    title: job.title,
    status: aliasOf || (job.listingStatus === "closed" && ["triaged", "review"].includes(opts.status || "triaged")) ? "archived" : opts.status || "triaged",
    archiveReason: aliasOf
      ? `aggregator_duplicate: ${aggregator} repost of ${aliasOf.slug}`.slice(0, 300)
      : job.listingStatus === "closed" && ["triaged", "review"].includes(opts.status || "triaged") ? "listing_closed" : null,
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
      ...needsJdPatch(null, jd, 1),
      ...fetchFailureMetadata(job),
      requisitionId: job.requisitionId || requisitionId(job.descriptionText),
      ...(aggregatorMeta ? { aggregator: aggregatorMeta } : {}),
      ...(aliasOf ? { duplicateOfId: aliasOf.id } : {}),
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
  if (aliasOf) {
    await addEvent({ positionId: posId, kind: "duplicate", title: `Aggregator repost of ${aliasOf.title}`, body: `${aggregator} lists the same role at ${company.name}.`, metadata: { duplicateOfId: aliasOf.id, aggregator } });
    await addEvent({ positionId: aliasOf.id, kind: "duplicate", title: `Also listed on ${aggregator}`, body: job.url, metadata: { aliasId: posId, url: job.url, aggregator } });
    // An alias needs no decision of its own: the original carries it.
    return { position: (await getPosition(posId))!, created: true, revived: false };
  }
  if (!jd.sufficient) {
    await addEvent({ positionId: posId, kind: "harness", title: "Needs JD: too little description to score", body: `${jd.words} words beyond the title (${jd.reason}). Triage, evaluation and research wait for a fuller JD.` });
  }
  const createdPos = (await getPosition(posId))!;
  await afterAtsFetch(posId, job, facts);
  if (jd.sufficient) {
    const { enqueuePositionDecision } = await import("./decision-events.js");
    await enqueuePositionDecision(posId, 1);
  }
  return { position: createdPos, created: true, revived: false };
}

/** The filing an aggregator repost duplicates: same employer, same role title, not itself an alias. */
async function aggregatorOriginal(companyId: string, title: string) {
  const db = await getDb();
  const want = decisionTitle(title);
  if (!want) return null;
  const rows = await db
    .select({ id: positions.id, slug: positions.slug, title: positions.title, status: positions.status, listingStatus: positions.listingStatus, firstSeenAt: positions.firstSeenAt, metadata: positions.metadata })
    .from(positions)
    .where(eq(positions.companyId, companyId));
  const hot = (s: string) => ["materials", "applied", "screen", "interview", "offer"].includes(s);
  return rows
    .filter(r => decisionTitle(r.title) === want && !(r.metadata as Record<string, unknown> | null)?.duplicateOfId)
    .sort((a, b) => Number(hot(b.status)) - Number(hot(a.status))
      || Number(b.listingStatus !== "closed") - Number(a.listingStatus !== "closed")
      || (a.firstSeenAt?.getTime() || 0) - (b.firstSeenAt?.getTime() || 0))[0] ?? null;
}

async function afterAtsFetch(positionId: string, job: AtsJob, facts?: ReturnType<typeof classifyListing>) {
  const pos = await getPosition(positionId);
  if (!pos) return;
  const f = applyClassificationOverride(pos.metadata,
    facts ??
    classifyListing({
      locationRaw: job.locationRaw,
      workplaceType: job.workplaceType,
      isRemote: job.isRemote,
      company: pos.company.name,
      title: job.title || pos.title,
      descriptionText: job.descriptionText,
    }));
  const db = await getDb();
  const prev = (pos.metadata || {}) as Record<string, unknown>;
  const ats = { ...((prev.ats as Record<string, unknown>) || {}), workplaceType: job.workplaceType ?? null, isRemote: job.isRemote ?? null };
  const changed = f.workplace !== pos.workplace || f.geoClass !== pos.geoClass || f.remoteClass !== pos.remoteClass
    || Boolean(job.employmentType && job.employmentType !== pos.employmentType);
  await db
    .update(positions)
    .set({
      workplace: f.workplace,
      geoClass: f.geoClass,
      remoteClass: f.remoteClass,
      ...(job.employmentType ? { employmentType: job.employmentType } : {}),
      metadata: { ...prev, ats },
      ...(changed ? { updatedAt: new Date() } : {}),
    })
    .where(eq(positions.id, positionId));
  const { harvestFromJob } = await import("./questions.js");
  await harvestFromJob(positionId, job);
  const { maybeEnqueueListingClassify } = await import("./listing-classify.js");
  await maybeEnqueueListingClassify(positionId, f);
}

/** The board location was one office. The other offices name more places. Rewrite the latest snapshot in place. */
export async function expandStoredOfficeLocations(): Promise<{ checked: number; updated: number }> {
  const db = await getDb();
  const rows = await db
    .select({
      id: positions.id,
      title: positions.title,
      company: companies.name,
      metadata: positions.metadata,
      salaryRaw: positions.salaryRaw,
      workplace: positions.workplace,
      status: positions.status,
      archiveReason: positions.archiveReason,
    })
    .from(positions)
    .innerJoin(companies, eq(companies.id, positions.companyId))
    .where(eq(positions.atsProvider, "greenhouse"));
  let updated = 0;
  for (const row of rows) {
    const ats = ((row.metadata || {}) as { ats?: { offices?: unknown; workplaceType?: string | null; isRemote?: boolean | null } }).ats;
    const offices = Array.isArray(ats?.offices) ? ats.offices.filter((office): office is string => typeof office === "string") : [];
    if (offices.length < 2) continue;
    const rev = (
      await db.select().from(jdRevisions).where(eq(jdRevisions.positionId, row.id)).orderBy(desc(jdRevisions.revision)).limit(1)
    )[0];
    if (!rev?.locationRaw) continue;
    let next = greenhouseListingLocation(rev.locationRaw, offices).locationRaw?.trim();
    const distributed = greenhouseListingLocation("Distributed", offices).locationRaw?.trim();
    const bareOffices = distributed?.replace(/^Distributed · /, "");
    const withdrawnAsOnsite = offices.length >= 3 && row.workplace === "onsite" && (row.archiveReason || "").includes("geo_block:onsite");
    if (withdrawnAsOnsite && distributed && bareOffices && rev.locationRaw.trim() === bareOffices && distributed !== rev.locationRaw.trim()) {
      next = distributed;
    }
    if (!next || next === rev.locationRaw.trim()) continue;
    const restore = next.startsWith("Distributed · ") && withdrawnAsOnsite;
    const computed = classifyListing({
      locationRaw: next,
      workplaceType: ats?.workplaceType,
      isRemote: ats?.isRemote,
      company: row.company,
      title: row.title,
      descriptionText: rev.descriptionText,
    });
    const hash = contentHash({
      title: rev.title || row.title,
      descriptionText: rev.descriptionText,
      salaryRaw: rev.salaryRaw || row.salaryRaw,
      locationRaw: next,
    });
    const facts = applyClassificationOverride(row.metadata, computed);
    await db
      .update(jdRevisions)
      .set({ locationRaw: next, geoClass: computed.geoClass, remoteClass: computed.remoteClass, contentHash: hash })
      .where(eq(jdRevisions.id, rev.id));
    await db
      .update(positions)
      .set({
        geoClass: facts.geoClass,
        remoteClass: facts.remoteClass,
        workplace: facts.workplace,
        contentHash: hash,
        ...(restore ? { status: "triaged" as const, archiveReason: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, row.id));
    await db
      .update(discoveryFeed)
      .set({
        locationRaw: next,
        geoClass: facts.geoClass,
        ...(restore ? { lane: "passed" as const, gateReason: null } : {}),
      })
      .where(and(eq(discoveryFeed.positionId, row.id), eq(discoveryFeed.locationRaw, rev.locationRaw)));
    updated++;
  }
  return { checked: rows.length, updated };
}

/** Pull Ashby application questions for filings that only had the empty HTML shell. */
export async function repairAshbyForms(): Promise<{ checked: number; updated: number; failed: number }> {
  const db = await getDb();
  const rows = await db
    .select({ id: positions.id, token: positions.atsBoardToken, jobId: positions.atsJobId, status: positions.status })
    .from(positions)
    .where(eq(positions.atsProvider, "ashby"));
  const open = rows.filter((row) => row.status !== "archived" && row.token && row.jobId);
  const { fetchAshbyJob } = await import("@job-scout/ats");
  const { harvestFromJob } = await import("./questions.js");
  let updated = 0;
  let failed = 0;
  for (const row of open) {
    try {
      const job = await fetchAshbyJob(row.token!, row.jobId!);
      if (!job.questionPrompts?.length) continue;
      await harvestFromJob(row.id, job);
      updated++;
    } catch {
      failed++;
    }
  }
  return { checked: open.length, updated, failed };
}

/** Fill employment type from Greenhouse metadata without writing a new JD revision. */
export async function repairGreenhouseEmployment(): Promise<{ checked: number; updated: number; failed: number }> {
  const db = await getDb();
  const rows = await db
    .select({
      id: positions.id,
      token: positions.atsBoardToken,
      jobId: positions.atsJobId,
      status: positions.status,
      employmentType: positions.employmentType,
    })
    .from(positions)
    .where(eq(positions.atsProvider, "greenhouse"));
  const open = rows.filter((row) => row.status !== "archived" && row.token && row.jobId && !row.employmentType);
  const { fetchGreenhouseJob } = await import("@job-scout/ats");
  let updated = 0;
  let failed = 0;
  for (const row of open) {
    try {
      const job = await fetchGreenhouseJob(row.token!, row.jobId!);
      if (!job.employmentType) continue;
      await db.update(positions).set({ employmentType: job.employmentType, updatedAt: new Date() }).where(eq(positions.id, row.id));
      updated++;
    } catch {
      failed++;
    }
  }
  return { checked: open.length, updated, failed };
}

/** First-snapshot lastAtsFetch carrying the fetcher's failure, if any. */
function fetchFailureMetadata(job: AtsJob): Record<string, unknown> {
  const f = fetchFailureOf(job);
  return f.failure ? { lastAtsFetch: { at: new Date().toISOString(), provider: job.provider, listingStatus: job.listingStatus, ...f } } : {};
}

/** The fetcher's structured "loaded but empty" verdict, for metadata.lastAtsFetch. */
function fetchFailureOf(job: AtsJob): { failure?: AtsFetchFailure } {
  const failure = (job.rawPayload as { fetchFailure?: AtsFetchFailure } | undefined)?.fetchFailure;
  return failure && typeof failure === "object" && typeof failure.reason === "string" ? { failure } : {};
}

/**
 * A fetch that threw: store the structured reason in metadata.lastAtsFetch and
 * the timeline, keep every field of the position, and return the error to rethrow.
 */
export async function recordAtsFetchFailure(positionId: string, error: unknown, source = "refresh"): Promise<AtsFetchError> {
  const pos = await getPosition(positionId);
  const failure = classifyFetchError(error, { url: pos?.primaryUrl || undefined, provider: pos?.atsProvider || undefined });
  if (!pos) return failure;
  const db = await getDb();
  const now = new Date();
  await db
    .update(positions)
    .set({
      updatedAt: now,
      metadata: { ...(pos.metadata || {}), lastAtsFetch: { at: now.toISOString(), provider: pos.atsProvider, listingStatus: pos.listingStatus, source, error: failure.toJSON() } },
    })
    .where(eq(positions.id, pos.id));
  await addEvent({
    positionId: pos.id,
    kind: "harness",
    title: `JD fetch failed: ${failure.reason}${failure.httpStatus ? ` (HTTP ${failure.httpStatus})` : ""}`.slice(0, 300),
    body: failure.message.slice(0, 1000),
    metadata: { source, ...failure.toJSON() },
  });
  log.warn("jd.fetch_failed", { positionId: pos.id, source, reason: failure.reason, httpStatus: failure.httpStatus, causeCode: failure.causeCode });
  return failure;
}

/** Fetch the ATS page for a position and apply. A failed fetch throws an AtsFetchError with a reason. */
export async function refreshPosition(idOrSlug: string, source = "refresh", opts: { force?: boolean } = {}) {
  const pos = await getPosition(idOrSlug);
  if (!pos) throw new Error("position not found");
  if (!pos.primaryUrl) throw new Error("position has no URL");
  let job: AtsJob;
  try {
    job = await fetchJobFromUrl(pos.primaryUrl);
  } catch (e) {
    throw await recordAtsFetchFailure(pos.id, e, source);
  }
  const result = await applySnapshot({ positionId: pos.id, job, source, force: opts.force });
  const { failure } = fetchFailureOf(job);
  return failure ? { ...result, fetchFailure: failure } : result;
}

/**
 * Rows changed since a timestamp — for the career-ops sync skill. Keyed on
 * positions.updated_at, which moves on operator-visible changes (status, notes,
 * JD revisions, triage, listing facts) and not on unchanged watch checks, form
 * harvests or career-ops stamps. Pages positions first, then evaluations, by
 * keyset at full timestamp precision. `now` is the watermark from the first
 * page, repeated on every page: use it as the next `since` once nextCursor is null.
 */
export async function listChangesSince(since: Date, opts: number | { limit?: number; cursor?: string } = {}) {
  const o = typeof opts === "number" ? { limit: opts } : opts;
  const limit = Math.min(500, Math.max(1, Math.floor(o.limit ?? 200)));
  const s = "changes";
  const f = filterFingerprint({ since: since.toISOString() });
  const cursor = o.cursor ? decodeCursor(o.cursor, { s, f }) : null;
  const now = cursor?.w ?? new Date().toISOString();
  const db = await getDb();

  let posRows: Awaited<ReturnType<typeof changedPositions>> = [];
  let positionsMore = false;
  if (!cursor?.e) {
    const rows = await changedPositions(since, cursor?.k, limit + 1);
    positionsMore = rows.length > limit;
    posRows = rows.slice(0, limit);
  }
  let evRows: { id: string; positionId: string | null; kind: string; model: string | null; createdAt: Date; cursorTs: string }[] = [];
  let evaluationsMore = false;
  if (!positionsMore) {
    const after = cursor?.e ? sql`(${evaluations.createdAt}, ${evaluations.id}) > (${cursor.e[0]}::timestamptz, ${cursor.e[1]})` : undefined;
    const rows = await db
      .select({ id: evaluations.id, positionId: evaluations.positionId, kind: evaluations.kind, model: evaluations.model, createdAt: evaluations.createdAt, cursorTs: sql<string>`to_json(${evaluations.createdAt})#>>'{}'` })
      .from(evaluations)
      .where(and(gt(evaluations.createdAt, since), after))
      .orderBy(asc(evaluations.createdAt), asc(evaluations.id))
      .limit(limit + 1);
    evaluationsMore = rows.length > limit;
    evRows = rows.slice(0, limit);
  }
  // A positions cursor past the last changed position resumes with the first evaluation.
  const positionCursors = posRows.map((r) => encodeCursor({ s, f, w: now, k: [r.cursorTs, r.id] }));
  const evaluationCursors = evRows.map((r) => encodeCursor({ s, f, w: now, e: [r.cursorTs, r.id] }));
  const nextCursor = positionsMore ? positionCursors.at(-1) ?? null : evaluationsMore ? evaluationCursors.at(-1) ?? null : null;
  return {
    positions: posRows.map(({ cursorTs: _cursorTs, ...row }) => row),
    evaluations: evRows.map(({ cursorTs: _cursorTs, ...row }) => row),
    now,
    nextCursor,
    /** more changed positions remain, so this page carries no evaluations */
    positionsMore,
    positionCursors,
    evaluationCursors,
  };
}

async function changedPositions(since: Date, after: [string, string] | undefined, limit: number) {
  const db = await getDb();
  return db
    .select({ ...LIST_ROW, cursorTs: sql<string>`to_json(${positions.updatedAt})#>>'{}'` })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id))
    .where(and(gt(positions.updatedAt, since), after ? sql`(${positions.updatedAt}, ${positions.id}) > (${after[0]}::timestamptz, ${after[1]})` : undefined))
    .orderBy(asc(positions.updatedAt), asc(positions.id))
    .limit(limit);
}
