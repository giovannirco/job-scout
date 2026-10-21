/**
 * Find status writes from the career-ops sync that moved a role backwards in the
 * last N days and put each still-reversed role back to its prior status.
 * Dry-run by default; writes only with --apply.
 *
 *   pnpm db:repair-career-ops-reversals [--days 7] [--actors agent-a,agent-b] [--apply]
 *   pnpm db:repair-career-ops-reversals --snapshot export.json [--days 7] [--actors …]   # plan only, no database
 *
 * --actors adds the agent token names the local sync runs under (their writes are
 * not named career-ops). --snapshot takes { positions: [{id,status,listingStatus,archiveReason}],
 * events: [{id,positionId,kind,title,actor,createdAt}] } built from read-only MCP data.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const days = Number(flag("--days") ?? 7);
if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
const actors = (flag("--actors") || "").split(",").map((s) => s.trim()).filter(Boolean);
const snapshot = flag("--snapshot");
if (snapshot) {
  if (args.includes("--apply")) throw new Error("--snapshot plans only; it cannot --apply");
  const { planCareerOpsReversals } = await import("../career-ops-reversals.js");
  const data = JSON.parse(readFileSync(snapshot, "utf8"));
  const since = new Date(Date.now() - days * 86_400_000);
  console.log(JSON.stringify({ dryRun: true, source: "snapshot", since: since.toISOString(), plans: planCareerOpsReversals({ ...data, since, actors }) }, null, 2));
} else {
  const { closeDb } = await import("@job-scout/db");
  const { repairCareerOpsReversals } = await import("../career-ops-reversals.js");
  try {
    console.log(JSON.stringify(await repairCareerOpsReversals({ days, actors, apply: args.includes("--apply") }), null, 2));
  } finally {
    await closeDb();
  }
}
