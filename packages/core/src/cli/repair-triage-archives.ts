/**
 * Restore triage auto-archives whose reason is not a hard disqualifier
 * (residency, work authorization, onsite/hybrid, posted pay under the floor).
 * Dry-run by default; writes only with --apply. Scores are kept.
 * Also lists (never changes) skips driven by a career-ops tracker drop label.
 *   pnpm db:repair-triage-archives [--days 30] [--apply]
 */
import { closeDb } from "@job-scout/db";
import { repairTriageArchives } from "../triage-archive-repair.js";

const args = process.argv.slice(2);
const i = args.indexOf("--days");
const days = i >= 0 ? Number(args[i + 1]) : 30;
if (!Number.isFinite(days) || days <= 0) throw new Error("Usage: pnpm db:repair-triage-archives [--days N] [--apply]");
try {
  console.log(JSON.stringify(await repairTriageArchives({ days, apply: args.includes("--apply") }), null, 2));
} finally {
  await closeDb();
}
