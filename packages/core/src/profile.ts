import { eq } from "drizzle-orm";
import { getDb, id, profiles } from "@job-scout/db";
import { DEFAULT_SCOUT_BRIEF } from "@job-scout/llm";
import { createHash } from "node:crypto";
import { updateSettings } from "./settings.js";
import { regateRecentDiscovery } from "./scan.js";

export type Profile = typeof profiles.$inferSelect;

/** Scores depend on these inputs; contact-only edits do not invalidate them. */
export function profileFingerprint(p: Profile): string {
  return createHash("sha256").update(JSON.stringify([
    briefOf(p), p.identityMarkdown, p.masterResumeMarkdown, p.targetRoles,
    p.cashFloorUsd, p.northStar,
  ])).digest("hex").slice(0, 20);
}

export async function getProfile(): Promise<Profile> {
  const db = await getDb();
  const row = (await db.select().from(profiles).limit(1))[0];
  if (row) return row;
  const pid = id("prof");
  await db.insert(profiles).values({
    id: pid,
    displayName: "Operator",
    scoutBrief: DEFAULT_SCOUT_BRIEF,
    targetRoles: ["Platform Engineer", "SRE", "DevOps Engineer"],
    resumeSurfaces: {},
  });
  return (await db.select().from(profiles).where(eq(profiles.id, pid)).limit(1))[0]!;
}

const EDITABLE = new Set([
  "displayName",
  "email",
  "location",
  "linkedinUrl",
  "githubUrl",
  "lastTitle",
  "lastCompany",
  "cashFloorUsd",
  "northStar",
  "targetRoles",
  "resumeSurfaces",
  "identityMarkdown",
  "masterResumeMarkdown",
  "masterCoverMarkdown",
  "scoutBrief",
  "metadata",
]);

export async function updateProfile(patch: Record<string, unknown>): Promise<Profile> {
  const db = await getDb();
  const current = await getProfile();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) if (EDITABLE.has(k)) set[k] = v;
  await db.update(profiles).set(set).where(eq(profiles.id, current.id));
  return (await db.select().from(profiles).where(eq(profiles.id, current.id)).limit(1))[0]!;
}

export function briefOf(p: Profile): string {
  return (p.scoutBrief || DEFAULT_SCOUT_BRIEF).trim();
}

/** Lowercased title-gate terms from profile target roles. Drops blanks and duplicates. */
export function titleIncludesFromRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of roles) {
    const term = String(role).trim().toLowerCase();
    if (term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/** Point the title gate at these roles and recheck listings already in discovery. */
export async function syncGateFromTargetRoles(roles: string[]): Promise<{
  titleInclude: string[];
  regate: Awaited<ReturnType<typeof regateRecentDiscovery>>;
} | null> {
  const titleInclude = titleIncludesFromRoles(roles);
  if (!titleInclude.length) return null;
  await updateSettings({ gate: { titleInclude } });
  const regate = await regateRecentDiscovery();
  return { titleInclude, regate };
}
