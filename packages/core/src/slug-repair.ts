import { eq } from "drizzle-orm";
import { companies, getDb, positions, slugify } from "@job-scout/db";
import { canonicalCompanySlug, isPrototypeSlug, titleSignature } from "@job-scout/shared";
import { addEvent } from "./timeline.js";

export type SlugRepairPlan = { id: string; name: string; from: string; to: string };

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
    .select({ id: positions.id, title: positions.title, slug: positions.slug, companyId: positions.companyId, metadata: positions.metadata, companySlug: companies.slug })
    .from(positions)
    .innerJoin(companies, eq(positions.companyId, companies.id));
  const positionPlan: SlugRepairPlan[] = [];
  for (const p of pos) {
    const bad = isPrototypeSlug(p.slug);
    // A repaired company also reslugs positions whose slug was derived from its old slug.
    if (!bad && !(newCompanySlug.has(p.companyId) && p.slug.startsWith(slugify(p.companySlug)))) continue;
    const co = newCompanySlug.get(p.companyId) || p.companySlug;
    const to = positionSlugFor(co, p.title, p.id);
    if (to !== p.slug) positionPlan.push({ id: p.id, name: p.title, from: p.slug, to });
  }
  if (!opts.apply) return { dryRun: true as const, companies: companyPlan, positions: positionPlan };
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
  return { dryRun: false as const, companies: companyPlan, positions: positionPlan };
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
