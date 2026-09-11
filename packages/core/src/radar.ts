import { and, asc, desc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { boardDeltas, boardSources, discoveryFeed, getDb, positions } from "@job-scout/db";
import { parseListSort } from "@job-scout/shared";
import { boardErrorKind } from "./board-reconcile.js";

export async function listDiscovery(q: {
  lane?: string;
  q?: string;
  hours?: string;
  page?: string;
  pageSize?: string;
  cursor?: string;
  reason?: string;
  sort?: string;
}) {
  const db = await getDb();
  const page = Math.max(1, Number(q.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize || 50)));
  const conds: SQL[] = [];
  if (q.lane && q.lane !== "all") conds.push(eq(discoveryFeed.lane, q.lane as never));
  if (q.hours) conds.push(gte(discoveryFeed.observedAt, new Date(Date.now() - Number(q.hours) * 3_600_000)));
  if (q.reason) conds.push(ilike(discoveryFeed.gateReason, `${q.reason}%`));
  if (q.q) conds.push(or(ilike(discoveryFeed.title, `%${q.q}%`), ilike(discoveryFeed.company, `%${q.q}%`))!);
  if (q.cursor) {
    const d = new Date(q.cursor);
    if (!Number.isNaN(d.getTime())) conds.push(sql`${discoveryFeed.observedAt} < ${d}`);
  }
  const where = conds.length ? and(...conds) : undefined;
  const { field, dir } = parseListSort(q.sort, ["observed", "title", "company", "location", "lane"], "observed", "desc");
  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order =
    field === "title"
      ? [d(discoveryFeed.title), desc(discoveryFeed.id)]
      : field === "company"
        ? [d(discoveryFeed.company), desc(discoveryFeed.id)]
        : field === "location"
          ? [d(discoveryFeed.locationRaw), desc(discoveryFeed.id)]
          : field === "lane"
            ? [d(discoveryFeed.lane), desc(discoveryFeed.observedAt)]
            : [d(discoveryFeed.observedAt), desc(discoveryFeed.id)];
  const rows = await db
    .select({
      id: discoveryFeed.id,
      externalIdentity: discoveryFeed.externalIdentity,
      company: discoveryFeed.company,
      title: discoveryFeed.title,
      url: discoveryFeed.url,
      locationRaw: discoveryFeed.locationRaw,
      craftFamily: discoveryFeed.craftFamily,
      geoClass: discoveryFeed.geoClass,
      lane: discoveryFeed.lane,
      gateReason: discoveryFeed.gateReason,
      provider: discoveryFeed.provider,
      observedAt: discoveryFeed.observedAt,
      positionId: discoveryFeed.positionId,
      positionSlug: positions.slug,
      positionStatus: positions.status,
      triageVerdict: positions.triageVerdict,
      triageScore: positions.triageScore,
    })
    .from(discoveryFeed)
    .leftJoin(
      positions,
      sql`(${positions.id} = ${discoveryFeed.positionId}) or (${discoveryFeed.positionId} is null and ${positions.externalIdentity} is not null and ${positions.externalIdentity} = ${discoveryFeed.externalIdentity})`,
    )
    .where(where)
    .orderBy(...order)
    .limit(pageSize)
    .offset(q.cursor ? 0 : (page - 1) * pageSize);
  const total = (await db.select({ c: sql<number>`count(*)::int` }).from(discoveryFeed).where(where))[0]?.c ?? 0;
  const last = rows[rows.length - 1];
  return { items: rows, page, pageSize, total, nextCursor: rows.length === pageSize && last ? last.observedAt.toISOString() : null };
}

export async function discoverySummary(hours = 24) {
  const db = await getDb();
  const since = new Date(Date.now() - hours * 3_600_000);
  const lanes = await db
    .select({ lane: discoveryFeed.lane, c: sql<number>`count(*)::int` })
    .from(discoveryFeed)
    .where(gte(discoveryFeed.observedAt, since))
    .groupBy(discoveryFeed.lane);
  const reasons = await db
    .select({ reason: sql<string>`split_part(coalesce(${discoveryFeed.gateReason},'pass'), ':', 1)`, c: sql<number>`count(*)::int` })
    .from(discoveryFeed)
    .where(and(gte(discoveryFeed.observedAt, since), eq(discoveryFeed.lane, "filtered")))
    .groupBy(sql`split_part(coalesce(${discoveryFeed.gateReason},'pass'), ':', 1)`)
    .orderBy(desc(sql`count(*)`));
  const boards = (
    await db
      .select({
        total: sql<number>`count(*)::int`,
        enabled: sql<number>`count(*) filter (where ${boardSources.enabled})::int`,
        scanned24h: sql<number>`count(*) filter (where ${boardSources.lastScannedAt} > ${since})::int`,
        errored: sql<number>`count(*) filter (where ${boardSources.lastError} is not null)::int`,
      })
      .from(boardSources)
  )[0];
  return { since: since.toISOString(), lanes, reasons, boards };
}

export async function listDeltas(q: { hours?: string; event?: string; limit?: string }) {
  const db = await getDb();
  const conds: SQL[] = [gte(boardDeltas.observedAt, new Date(Date.now() - Number(q.hours || 72) * 3_600_000))];
  if (q.event) conds.push(eq(boardDeltas.event, q.event));
  return db
    .select()
    .from(boardDeltas)
    .where(and(...conds))
    .orderBy(desc(boardDeltas.observedAt))
    .limit(Math.min(500, Number(q.limit || 100)));
}

export async function listBoards(q: { q?: string; enabled?: string; sort?: string }) {
  const db = await getDb();
  const conds: SQL[] = [];
  if (q.q) conds.push(or(ilike(boardSources.company, `%${q.q}%`), ilike(boardSources.token, `%${q.q}%`))!);
  if (q.enabled === "true") conds.push(eq(boardSources.enabled, true));
  if (q.enabled === "false") conds.push(eq(boardSources.enabled, false));
  const { field, dir } = parseListSort(q.sort, ["company", "provider", "token", "last_scanned"], "company", "asc");
  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order =
    field === "provider"
      ? [d(boardSources.provider), asc(boardSources.company)]
      : field === "token"
        ? [d(boardSources.token)]
        : field === "last_scanned"
          ? [d(boardSources.lastScannedAt), asc(boardSources.company)]
          : [d(boardSources.company)];
  const rows = await db
    .select()
    .from(boardSources)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order)
    .limit(1000);
  return rows.map(row => ({ ...row, errorKind: boardErrorKind(row.lastError) }));
}
