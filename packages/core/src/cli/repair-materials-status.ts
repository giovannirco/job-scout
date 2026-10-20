/**
 * List positions in status `materials` that have no materials on file.
 * Dry-run by default; --apply moves each back to the stage it came from (review/triaged).
 *
 *   pnpm db:repair-materials-status [--apply]
 */
import { closeDb } from "@job-scout/db";
import { repairMaterialsWithoutFiles } from "../pipeline-integrity.js";

try {
  console.log(JSON.stringify(await repairMaterialsWithoutFiles({ apply: process.argv.includes("--apply") }), null, 2));
} finally {
  await closeDb();
}
