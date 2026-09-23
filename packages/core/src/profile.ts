import { eq } from "drizzle-orm";
import { getDb, id, profiles } from "@job-scout/db";
import { DEFAULT_SCOUT_BRIEF } from "@job-scout/llm";
import { DEFAULT_GATE } from "@job-scout/shared";
import { createHash } from "node:crypto";
import { updateSettings, getSettings } from "./settings.js";
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

/** Words that only describe seniority or a generic job shape. A specialty token such as "java" is kept on its own. */
const ROLE_FILLER = new Set([
  "engineer", "engineering", "senior", "staff", "principal", "lead", "junior",
  "software", "developer", "development", "backend", "frontend", "full", "stack",
  "fullstack", "site", "reliability", "platform", "devops", "sre", "manager",
  "intern", "associate",
]);

function pushTerm(seen: Set<string>, out: string[], term: string) {
  if (term.length < 2 || seen.has(term)) return;
  seen.add(term);
  out.push(term);
}

/** Lowercased title-gate terms from profile target roles. Drops blanks and duplicates. */
export function titleIncludesFromRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const role of roles) {
    const phrase = String(role).trim().toLowerCase().replace(/\s+/g, " ");
    if (phrase.length < 2) continue;
    pushTerm(seen, out, phrase);
    for (const token of phrase.split(/[^a-z0-9+#]+/)) {
      if (ROLE_FILLER.has(token)) continue;
      pushTerm(seen, out, token);
    }
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

function sameTerms(a: string[], b: string[]): boolean {
  return [...a].sort().join("\0") === [...b].sort().join("\0");
}

/** A fresh install stores the starter title list, which is wider than the roles on the profile. Point it at those roles once. A custom list is left alone. */
export async function alignStarterGateWithRoles(): Promise<string[] | null> {
  const settings = await getSettings({ fresh: true });
  if (!sameTerms(settings.gate.titleInclude, DEFAULT_GATE.titleInclude)) return null;
  const titleInclude = titleIncludesFromRoles((await getProfile()).targetRoles);
  if (!titleInclude.length || sameTerms(titleInclude, settings.gate.titleInclude)) return null;
  await updateSettings({ gate: { titleInclude } });
  await regateRecentDiscovery();
  return titleInclude;
}
