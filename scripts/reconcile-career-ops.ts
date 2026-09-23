import { closeDb, runMigrations } from "@job-scout/db";
import { reconcileCareerOps } from "@job-scout/core";
import { trackerExport } from "./tracker-export.js";

const file = process.argv.slice(2).find(a => !a.startsWith("--"));
if (!file) throw new Error("Usage: pnpm exec tsx scripts/reconcile-career-ops.ts <export> [--apply]");
try {
  await runMigrations();
  console.log(JSON.stringify(await reconcileCareerOps({ rows: trackerExport(file), dryRun: !process.argv.includes("--apply") }), null, 2));
} finally { await closeDb(); }
