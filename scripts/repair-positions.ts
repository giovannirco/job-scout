import { closeDb, runMigrations } from "@job-scout/db";
import { repairPositionData } from "@job-scout/core";

try {
  await runMigrations();
  console.log(JSON.stringify(await repairPositionData({ dryRun: !process.argv.includes("--apply") }), null, 2));
} finally { await closeDb(); }
