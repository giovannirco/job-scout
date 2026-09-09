import { and, eq, ne, sql } from "drizzle-orm";
import { boardSources, getDb } from "@job-scout/db";
import { log as rootLog } from "@job-scout/shared";

const log = rootLog.child({ scope: "boards" });

/**
 * Verified board migrations (#18).
 *
 * Every entry was confirmed by a live read of the destination provider's public
 * list API on 2026-09-09, with a job count — not inferred from a brand name. The
 * board row keeps its id so discovery history and linked positions survive; the
 * previous provider/token is recorded in metadata so the move is reversible.
 */
export type BoardMigration = { company: string; from: { provider: string; token: string }; to: { provider: string; token: string }; verified: string; jobsAtVerification: number };

export const BOARD_MIGRATIONS: BoardMigration[] = [
  { company: "Wellhub", from: { provider: "greenhouse", token: "wellhub" }, to: { provider: "greenhouse", token: "gympass" }, verified: "2026-09-09", jobsAtVerification: 88 },
  { company: "Figma", from: { provider: "lever", token: "figma" }, to: { provider: "greenhouse", token: "figma" }, verified: "2026-09-09", jobsAtVerification: 159 },
  { company: "Circle", from: { provider: "greenhouse", token: "circle" }, to: { provider: "ashby", token: "circle" }, verified: "2026-09-09", jobsAtVerification: 10 },
  { company: "Black Forest Labs", from: { provider: "greenhouse", token: "blackforestlabs" }, to: { provider: "ashby", token: "black-forest-labs" }, verified: "2026-09-09", jobsAtVerification: 15 },
  { company: "Temporal", from: { provider: "greenhouse", token: "temporaltechnologies" }, to: { provider: "ashby", token: "temporal" }, verified: "2026-09-09", jobsAtVerification: 68 },
  { company: "Cursor", from: { provider: "ashby", token: "anysphere" }, to: { provider: "ashby", token: "cursor" }, verified: "2026-09-09", jobsAtVerification: 125 },
  { company: "Marqeta", from: { provider: "greenhouse", token: "marqeta" }, to: { provider: "ashby", token: "marqeta-inc" }, verified: "2026-09-09", jobsAtVerification: 42 },
];

/**
 * Employers with no board on any provider job-scout can list. Kept as explicit
 * manual_watch with a reason rather than left as a permanently-404ing list_api
 * source, which reads as coverage it does not have.
 */
export const UNSUPPORTED_BOARDS: Array<{ company: string; provider: string; token: string; reason: string }> = [
  { company: "Netflix", provider: "lever", token: "netflix", reason: "Moved to Eightfold (explore.jobs.netflix.net); no supported list API. Verified 2026-09-09." },
  { company: "Chainlink Labs", provider: "ashby", token: "chainlink-labs", reason: "No board on greenhouse/ashby/lever under any known token. Verified 2026-09-09." },
  { company: "Chainalysis", provider: "greenhouse", token: "chainalysis", reason: "No board on greenhouse/ashby/lever under any known token. Verified 2026-09-09." },
  { company: "HashiCorp", provider: "greenhouse", token: "hashicorp", reason: "No board on greenhouse/ashby/lever; careers moved post-IBM acquisition. Verified 2026-09-09." },
];

/**
 * Apply verified migrations in place and demote unsupported boards.
 * Idempotent: a board already on the destination is left alone, and a board
 * already demoted is not re-demoted. Never deletes a source.
 */
export async function reconcileBoardSources({ dryRun = true } = {}) {
  const db = await getDb();
  const migrated: string[] = [];
  const demoted: string[] = [];
  const conflicts: string[] = [];

  for (const m of BOARD_MIGRATIONS) {
    const src = (await db.select().from(boardSources).where(and(eq(boardSources.provider, m.from.provider), eq(boardSources.token, m.from.token))).limit(1))[0];
    if (!src) continue;
    // The unique index is (provider, token): if the destination already exists as
    // its own row, moving this one would collide. Demote the stale row instead so
    // the scanner stops calling a dead endpoint, and keep both histories.
    const dest = (await db.select({ id: boardSources.id }).from(boardSources).where(and(eq(boardSources.provider, m.to.provider), eq(boardSources.token, m.to.token))).limit(1))[0];
    if (dest && dest.id !== src.id) {
      conflicts.push(`${m.company}: ${m.to.provider}/${m.to.token} already exists as ${dest.id}`);
      if (!dryRun) {
        await db.update(boardSources).set({
          enabled: false, capability: "manual_watch", lastError: null,
          notes: `Superseded by ${dest.id} (${m.to.provider}/${m.to.token}). Verified ${m.verified}.`,
          metadata: { ...(src.metadata || {}), supersededBy: dest.id, previousBoard: m.from },
        }).where(eq(boardSources.id, src.id));
      }
      continue;
    }
    migrated.push(`${m.company}: ${m.from.provider}/${m.from.token} -> ${m.to.provider}/${m.to.token} (${m.jobsAtVerification} jobs at ${m.verified})`);
    if (!dryRun) {
      await db.update(boardSources).set({
        provider: m.to.provider, token: m.to.token,
        enabled: true, capability: "list_api", lastError: null,
        metadata: { ...(src.metadata || {}), previousBoard: m.from, migratedAt: new Date().toISOString(), verifiedJobs: m.jobsAtVerification },
      }).where(eq(boardSources.id, src.id));
    }
  }

  for (const u of UNSUPPORTED_BOARDS) {
    const src = (await db.select().from(boardSources).where(and(eq(boardSources.provider, u.provider), eq(boardSources.token, u.token), ne(boardSources.capability, "manual_watch"))).limit(1))[0];
    if (!src) continue;
    demoted.push(`${u.company}: ${u.provider}/${u.token} -> manual_watch`);
    if (!dryRun) {
      await db.update(boardSources).set({
        enabled: false, capability: "manual_watch", lastError: null, notes: u.reason,
        metadata: { ...(src.metadata || {}), demotedAt: new Date().toISOString(), demotedReason: u.reason },
      }).where(eq(boardSources.id, src.id));
    }
  }

  const out = { dryRun, migrated, demoted, conflicts, count: migrated.length + demoted.length };
  if (!dryRun && out.count) log.info("boards.reconciled", { migrated: migrated.length, demoted: demoted.length, conflicts: conflicts.length });
  return out;
}

/** A network abort is a transient condition, not evidence a board moved. */
export function boardErrorKind(error?: string | null): "missing" | "transient" | "none" {
  if (!error?.trim()) return "none";
  // Trailing \w* matters: the recorded value is "aborted", not "abort".
  return /\b(404|not found|gone|410)\b/i.test(error) ? "missing"
    : /\b(abort\w*|time\s?d?\s?out\w*|etimedout|econn\w*|esocket\w*|socket\w*|network\w*|enotfound|eai_again|503|502|504|429)\b/i.test(error) ? "transient"
    : "missing";
}
