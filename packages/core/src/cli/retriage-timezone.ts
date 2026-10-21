/**
 * Re-triage positions that failed or were auto-archived on a timezone
 * requirement alone (timezone windows no longer block). Dry-run by default;
 * --apply revives triage auto-archives and queues a forced triage for each
 * through the worker. --include adds position ids to the plan.
 *   pnpm db:retriage-timezone [--apply] [--include pos_a,pos_b]
 */
import { closeDb } from "@job-scout/db";
import { retriageTimezoneFails } from "../retriage-timezone.js";

const args = process.argv.slice(2);
const i = args.indexOf("--include");
if (i >= 0 && (!args[i + 1] || args[i + 1]!.startsWith("--"))) throw new Error("Usage: pnpm db:retriage-timezone [--apply] [--include id,id]");
const include = i >= 0 ? args[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean) : [];
try {
  console.log(JSON.stringify(await retriageTimezoneFails({ apply: args.includes("--apply"), include }), null, 2));
} finally {
  await closeDb();
}
