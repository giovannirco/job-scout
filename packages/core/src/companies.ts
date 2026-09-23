import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { boardSources, companies, evaluations, getDb, id, positions, slugify } from "@job-scout/db";
import { canonicalCompanySlug, isJobPostingUrl, parseListSort, preferredCompanyName } from "@job-scout/shared";

export type Company = typeof companies.$inferSelect;

export async function resolveCompanyForName(
  name: string,
  extras?: { website?: string | null; careersUrl?: string | null; overview?: string | null },
): Promise<Company> {
  const db = await getDb();
  const companySlug = canonicalCompanySlug(name);
  const displayName = preferredCompanyName(name, name);
  let company = (await db.select().from(companies).where(eq(companies.slug, companySlug)).limit(1))[0];
  if (!company) {
    const rawSlug = slugify(name);
    if (rawSlug && rawSlug !== companySlug) {
      company = (await db.select().from(companies).where(eq(companies.slug, rawSlug)).limit(1))[0];
    }
  }
  if (!company) {
    const cid = id("co");
    const slug = companySlug || slugify(name) || cid;
    const given = extras?.careersUrl && !isJobPostingUrl(extras.careersUrl) ? extras.careersUrl : null;
    const board = given ? null : (
      await db.select({ careersUrl: boardSources.careersUrl }).from(boardSources).where(sql`lower(${boardSources.company}) = lower(${displayName})`).limit(1)
    )[0];
    const careersUrl = given || (board?.careersUrl && !isJobPostingUrl(board.careersUrl) ? board.careersUrl : null);
    try {
      await db.insert(companies).values({
        id: cid,
        slug,
        name: displayName,
        website: extras?.website || null,
        careersUrl,
        overview: extras?.overview || null,
        metadata: {},
      }).onConflictDoNothing({ target: companies.slug });
      company = (await db.select().from(companies).where(eq(companies.slug, slug)).limit(1))[0];
      if (!company) throw new Error("company insert failed");
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      company = (await db.select().from(companies).where(eq(companies.slug, slug)).limit(1))[0];
      if (!company) throw err;
    }
  }
  return company;
}

/** Replace a careers link that is actually one opening with the board's careers root. */
export async function alignCompanyCareersFromBoards(): Promise<{ updated: number }> {
  const db = await getDb();
  const boards = await db.select({ company: boardSources.company, careersUrl: boardSources.careersUrl }).from(boardSources);
  let updated = 0;
  for (const board of boards) {
    if (!board.careersUrl || isJobPostingUrl(board.careersUrl)) continue;
    const rows = await db.select({ id: companies.id, careersUrl: companies.careersUrl }).from(companies).where(sql`lower(${companies.name}) = lower(${board.company})`);
    for (const row of rows) {
      if (row.careersUrl === board.careersUrl) continue;
      if (row.careersUrl && !isJobPostingUrl(row.careersUrl)) continue;
      await db.update(companies).set({ careersUrl: board.careersUrl, updatedAt: new Date() }).where(eq(companies.id, row.id));
      updated++;
    }
  }
  return { updated };
}

function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (o.code === "23505") return true;
    if (typeof o.message === "string" && /duplicate key|unique constraint|already exists/i.test(o.message)) return true;
    cur = o.cause;
  }
  return false;
}

export async function getCompany(idOrSlug: string) {
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(companies)
      .where(or(eq(companies.id, idOrSlug), eq(companies.slug, idOrSlug)))
      .limit(1)
  )[0];
  if (!row) return null;
  const pos = await db
    .select({
      id: positions.id,
      slug: positions.slug,
      title: positions.title,
      status: positions.status,
      triageScore: positions.triageScore,
      triageVerdict: positions.triageVerdict,
      listingStatus: positions.listingStatus,
      primaryUrl: positions.primaryUrl,
      updatedAt: positions.updatedAt,
    })
    .from(positions)
    .where(eq(positions.companyId, row.id))
    .orderBy(desc(positions.updatedAt))
    .limit(100);
  const research = (
    await db
      .select()
      .from(evaluations)
      .where(and(eq(evaluations.companyId, row.id), eq(evaluations.kind, "company_research")))
      .orderBy(desc(evaluations.createdAt))
      .limit(1)
  )[0];
  const boards = await db
    .select()
    .from(boardSources)
    .where(or(ilike(boardSources.company, row.name), eq(sql`lower(regexp_replace(${boardSources.company}, '[^a-zA-Z0-9]+', '-', 'g'))`, row.slug)))
    .limit(10);
  return { ...row, positions: pos, research: research ?? null, boards };
}

export async function listCompanies(q: { q?: string; page?: string; pageSize?: string; withPositions?: string; sort?: string }) {
  const db = await getDb();
  const page = Math.max(1, Number(q.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize || 50)));
  const conds = [];
  if (q.q) conds.push(or(ilike(companies.name, `%${q.q}%`), ilike(companies.slug, `%${q.q}%`)));
  const where = conds.length ? and(...conds) : undefined;
  const counts = db
    .select({
      companyId: positions.companyId,
      total: sql<number>`count(*)::int`.as("total"),
      open: sql<number>`count(*) filter (where ${positions.status} <> 'archived')::int`.as("open"),
      hot: sql<number>`count(*) filter (where ${positions.status} in ('review','materials','applied','screen','interview','offer'))::int`.as("hot"),
      pass: sql<number>`count(*) filter (where ${positions.triageVerdict} = 'pass' and ${positions.status} <> 'archived')::int`.as("pass"),
    })
    .from(positions)
    .groupBy(positions.companyId)
    .as("counts");
  const base = db
    .select({
      id: companies.id,
      slug: companies.slug,
      name: companies.name,
      website: companies.website,
      careersUrl: companies.careersUrl,
      industryTags: companies.industryTags,
      updatedAt: companies.updatedAt,
      positionsTotal: sql<number>`coalesce(${counts.total}, 0)`,
      positionsOpen: sql<number>`coalesce(${counts.open}, 0)`,
      positionsHot: sql<number>`coalesce(${counts.hot}, 0)`,
      positionsPass: sql<number>`coalesce(${counts.pass}, 0)`,
    })
    .from(companies)
    .leftJoin(counts, eq(counts.companyId, companies.id));
  const { field, dir } = parseListSort(q.sort, ["name", "hot", "pass", "total", "open", "updated"], "hot", "desc");
  const d = <T>(col: T) => (dir === "asc" ? asc(col as never) : desc(col as never));
  const order =
    field === "name"
      ? [d(companies.name)]
      : field === "pass"
        ? [d(sql`coalesce(${counts.pass},0)`), asc(companies.name)]
        : field === "total"
          ? [d(sql`coalesce(${counts.total},0)`), asc(companies.name)]
          : field === "open"
            ? [d(sql`coalesce(${counts.open},0)`), asc(companies.name)]
          : field === "updated"
            ? [d(companies.updatedAt), asc(companies.name)]
            : [d(sql`coalesce(${counts.hot},0)`), desc(sql`coalesce(${counts.pass},0)`), asc(companies.name)];
  const openOnly = sql`coalesce(${counts.open},0) > 0`;
  const rows = await (q.withPositions === "true"
    ? base.where(and(where, openOnly))
    : base.where(where)
  )
    .orderBy(...order)
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const total =
    (
      await db
        .select({ c: sql<number>`count(*)::int` })
        .from(companies)
        .leftJoin(counts, eq(counts.companyId, companies.id))
        .where(q.withPositions === "true" ? and(where, sql`coalesce(${counts.open},0) > 0`) : where)
    )[0]?.c ?? 0;
  return { items: rows, page, pageSize, total };
}

export async function updateCompany(idOrSlug: string, patch: Record<string, unknown>) {
  const db = await getDb();
  const row = await getCompany(idOrSlug);
  if (!row) return null;
  const allowed = ["name", "website", "careersUrl", "industryTags", "overview", "metadata"];
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  await db.update(companies).set(set).where(eq(companies.id, row.id));
  return getCompany(row.id);
}
