import { eq } from "drizzle-orm";
import { companies, getDb, jdRevisions, positions, slugify } from "@job-scout/db";
import { canonicalCompanySlug, canonicalExternalIdentity, isPrototypeSlug, isShellJobTitle, titleSignature } from "@job-scout/shared";
import { addEvent } from "./timeline.js";

export type SlugRepairPlan = { id: string; name: string; from: string; to: string };

/** Board-token segment of a `provider:token:jobId` identity, or null when it has no such shape. */
function identityToken(identity: string | null | undefined): string | null {
  const parts = String(identity || "").split(":");
  return parts.length >= 3 ? parts.slice(1, -1).join(":") : null;
}

/** Same identity with its board-token segment replaced, in canonical form. */
function withIdentityToken(identity: string, token: string): string {
  const parts = identity.split(":");
  return canonicalExternalIdentity(`${parts[0]}:${token}:${parts[parts.length - 1]}`) || identity;
}

/** Metadata with `slug` appended to previousSlugs (which getPosition/getCompany still resolve). */
export function withPrevious(metadata: Record<string, unknown> | null | undefined, slug: string): Record<string, unknown> {
  const m = { ...(metadata || {}) };
  const prev = Array.isArray(m.previousSlugs) ? m.previousSlugs.filter((s): s is string => typeof s === "string") : [];
  return { ...m, previousSlugs: [...new Set([...prev, slug])] };
}

/**
 * Find companies/positions whose slug came from an Object.prototype lookup
 * (company "Constructor" → "function Object() { [native code] }") and reslug
 * them. Dry-run unless `apply`. Old slugs are kept in metadata.previousSlugs,
 * which getPosition/getCompany resolve, so existing links keep working.
 * Positions whose external_identity (or ATS board token) embeds a
 * prototype-looking token get the corrected one too, even when the company
 * slug was already fixed by an earlier run.
 */
export async function repairPrototypeSlugs(opts: { apply?: boolean } = {}) {
  const db = await getDb();
  const cos = await db.select({ id: companies.id, name: companies.name, slug: companies.slug, metadata: companies.metadata }).from(companies);
  const taken = new Set(cos.map(c => c.slug));
  const companyPlan: SlugRepairPlan[] = [];
  const newCompanySlug = new Map<string, string>();
  for (const c of cos) {
    if (!isPrototypeSlug(c.slug)) continue;
    let to = canonicalCompanySlug(c.name) || slugify(c.name) || c.id;
    if (to === c.slug) continue;
    if (taken.has(to)) to = `${to}-${c.id.slice(-4).toLowerCase()}`;
    taken.add(to);
    newCompanySlug.set(c.id, to);
    companyPlan.push({ id: c.id, name: c.name, from: c.slug, to });
  }
  const pos = await db
    .select({
      id: positions.id, title: positions.title, slug: positions.slug, companyId: positions.companyId, metadata: positions.metadata,
      externalIdentity: positions.externalIdentity, atsBoardToken: positions.atsBoardToken, companySlug: companies.slug,
    })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id));
  const positionPlan: SlugRepairPlan[] = [];
  const identityPlan: Array<SlugRepairPlan & { boardToken?: string }> = [];
  for (const p of pos) {
    const bad = isPrototypeSlug(p.slug);
    // A repaired company also reslugs positions whose slug was derived from its old slug.
    if (!bad && !(newCompanySlug.has(p.companyId) && p.slug.startsWith(slugify(p.companySlug)))) continue;
    const co = newCompanySlug.get(p.companyId) || p.companySlug;
    const to = positionSlugFor(co, p.title, p.id);
    if (to !== p.slug) positionPlan.push({ id: p.id, name: p.title, from: p.slug, to });
  }
  for (const p of pos) {
    const badBoard = isPrototypeSlug(p.atsBoardToken);
    const token = identityToken(p.externalIdentity);
    if (!badBoard && !(token && isPrototypeSlug(token))) continue;
    const companySlug = newCompanySlug.get(p.companyId) || (isPrototypeSlug(p.companySlug) ? null : p.companySlug);
    const board = p.atsBoardToken && !badBoard ? p.atsBoardToken : companySlug;
    if (!board) continue;
    const from = p.externalIdentity || "";
    const to = token && isPrototypeSlug(token) ? withIdentityToken(from, board) : from;
    identityPlan.push({ id: p.id, name: p.title, from, to, ...(badBoard ? { boardToken: board } : {}) });
  }
  if (!opts.apply) return { dryRun: true as const, companies: companyPlan, positions: positionPlan, identities: identityPlan };
  const now = new Date();
  for (const c of companyPlan) {
    const row = cos.find(x => x.id === c.id)!;
    await db.update(companies).set({ slug: c.to, metadata: withPrevious(row.metadata, c.from), updatedAt: now }).where(eq(companies.id, c.id));
  }
  for (const p of positionPlan) {
    const row = pos.find(x => x.id === p.id)!;
    await db.update(positions).set({ slug: p.to, metadata: withPrevious(row.metadata, p.from), updatedAt: now }).where(eq(positions.id, p.id));
    await addEvent({ positionId: p.id, kind: "repair", title: `Slug repaired: ${p.from} → ${p.to}`, actor: "repair:prototype-slugs", metadata: { from: p.from, to: p.to } });
  }
  for (const p of identityPlan) {
    await db
      .update(positions)
      .set({ externalIdentity: p.to || null, ...(p.boardToken ? { atsBoardToken: p.boardToken } : {}), updatedAt: now })
      .where(eq(positions.id, p.id));
    await addEvent({
      positionId: p.id, kind: "repair", title: "External identity repaired", actor: "repair:prototype-slugs",
      metadata: { from: p.from, to: p.to, ...(p.boardToken ? { boardToken: p.boardToken } : {}) },
    });
  }
  return { dryRun: false as const, companies: companyPlan, positions: positionPlan, identities: identityPlan };
}

/** Position slug convention: slugify(`${companySlug}-${title}`) capped at 70, then "-" + the last 4 of the id. */
export function positionSlugFor(companySlug: string, title: string, positionId: string): string {
  return `${slugify(`${companySlug}-${title}`).slice(0, 70)}-${positionId.slice(-4)}`;
}

/** Was this position slug derived from a not-a-JD title (vendor boilerplate, "Job Not Found", a loading placeholder)? */
export function slugFromBadTitle(slug: string, companySlug: string): boolean {
  let body = slug.replace(/-[A-Za-z0-9_-]{4}$/, "");
  const co = slugify(companySlug);
  if (co && body.startsWith(`${co}-`)) body = body.slice(co.length + 1);
  const words = body.replace(/-/g, " ").trim();
  return Boolean(words) && Boolean(titleSignature(words));
}

/** Reslug when the current slug came from a bad title and a real title is known; null when nothing to do. */
export function reslugSuggestion(pos: { id: string; slug: string; company: { slug: string } }, realTitle: string): { from: string; to: string } | null {
  if (!realTitle.trim() || titleSignature(realTitle)) return null;
  if (!slugFromBadTitle(pos.slug, pos.company.slug)) return null;
  const to = positionSlugFor(pos.company.slug, realTitle, pos.id);
  return to === pos.slug ? null : { from: pos.slug, to };
}

/**
 * The slug a position should move to when its title changes, or null to keep it.
 * Only an auto-derived slug follows the title (one built from the old title, or
 * from any title the position carried before, or from a shell title such as
 * "Job openings"); a slug someone chose by hand never moves.
 */
export function slugForRetitle(
  pos: { id: string; slug: string; title: string; companySlug: string },
  newTitle: string,
  knownTitles: Array<string | null | undefined> = [],
): string | null {
  const next = positionSlugFor(pos.companySlug, newTitle, pos.id);
  if (!newTitle.trim() || next === pos.slug) return null;
  const titles = [pos.title, ...knownTitles].filter((t): t is string => Boolean(t && t.trim()));
  const derived = titles.some((t) => positionSlugFor(pos.companySlug, t, pos.id) === pos.slug);
  const fromShell = pos.slug.endsWith(`-${pos.id.slice(-4)}`) && titles.some((t) => isShellJobTitle(t));
  return derived || fromShell ? next : null;
}

/**
 * Positions whose slug was built from an earlier title (a bad first scrape, a
 * retitle on the board) and never followed the corrected title. Dry-run unless
 * `apply`; old slugs stay resolvable through metadata.previousSlugs.
 */
export async function repairStaleTitleSlugs(opts: { apply?: boolean } = {}) {
  const db = await getDb();
  const rows = await db
    .select({ id: positions.id, title: positions.title, slug: positions.slug, metadata: positions.metadata, companySlug: companies.slug })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id));
  const revs = await db.select({ positionId: jdRevisions.positionId, title: jdRevisions.title }).from(jdRevisions);
  const titlesBy = new Map<string, string[]>();
  for (const r of revs) if (r.title) titlesBy.set(r.positionId, [...(titlesBy.get(r.positionId) || []), r.title]);
  const taken = new Set(rows.map((r) => r.slug));
  const plan: SlugRepairPlan[] = [];
  for (const p of rows) {
    if (positionSlugFor(p.companySlug, p.title, p.id) === p.slug) continue;
    const earlier = titlesBy.get(p.id) || [];
    // Only a slug built from an earlier title, never a hand-picked one.
    if (!earlier.some((t) => positionSlugFor(p.companySlug, t, p.id) === p.slug)) continue;
    const to = positionSlugFor(p.companySlug, p.title, p.id);
    if (taken.has(to)) continue;
    taken.add(to);
    plan.push({ id: p.id, name: p.title, from: p.slug, to });
  }
  if (!opts.apply) return { dryRun: true as const, positions: plan };
  const now = new Date();
  for (const p of plan) {
    const row = rows.find((x) => x.id === p.id)!;
    await db.update(positions).set({ slug: p.to, metadata: withPrevious(row.metadata, p.from), updatedAt: now }).where(eq(positions.id, p.id));
    await addEvent({ positionId: p.id, kind: "repair", title: `Slug follows title: ${p.from} → ${p.to}`, actor: "repair:title-slugs", metadata: { from: p.from, to: p.to } });
  }
  return { dryRun: false as const, positions: plan };
}
