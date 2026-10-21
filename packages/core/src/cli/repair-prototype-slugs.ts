import { closeDb } from "@job-scout/db";
import { repairPrototypeSlugs } from "../slug-repair.js";

// Reslug companies/positions whose slug came from an Object.prototype key
// (company "Constructor" → "function Object() { [native code] }").
//   pnpm db:repair-prototype-slugs           # print the plan (dry-run)
//   pnpm db:repair-prototype-slugs --apply   # write; old slugs kept in metadata.previousSlugs
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--apply")) throw new Error("Usage: pnpm db:repair-prototype-slugs [--apply]");
try {
  const result = await repairPrototypeSlugs({ apply: args.includes("--apply") });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) console.log("Dry run; pass --apply to write.");
} finally {
  await closeDb();
}
