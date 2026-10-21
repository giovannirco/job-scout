import { closeDb } from "@job-scout/db";
import { repairStaleTitleSlugs } from "../slug-repair.js";

// Reslug positions whose slug was built from an earlier (bad or retitled) title.
//   pnpm db:repair-title-slugs           # print the plan (dry-run)
//   pnpm db:repair-title-slugs --apply   # write; old slugs kept in metadata.previousSlugs
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) throw new Error("Usage: pnpm db:repair-title-slugs [--apply]");
try {
  const result = await repairStaleTitleSlugs({ apply: args.includes("--apply") });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) console.log("Dry run; pass --apply to write.");
} finally {
  await closeDb();
}
