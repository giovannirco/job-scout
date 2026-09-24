import { openSync, writeFileSync, closeSync } from "node:fs";
import { closeDb } from "@job-scout/db";
import { runDataRepairs } from "../packages/core/src/repairs.js";

const args = process.argv.slice(2);
const mode = args.includes("--preview") ? "preview" : args.includes("--apply") ? "apply" : null;
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
if (!mode || (args.includes("--preview") && args.includes("--apply")) || !reportPath || reportPath.startsWith("--")) {
  throw new Error("Usage: pnpm db:repair (--preview | --apply) --report /private/path/report.json");
}
// Refuse overwrite, create with private permissions before doing any database work.
const fd = openSync(reportPath, "wx", 0o600);
try {
  const report = await runDataRepairs(mode);
  writeFileSync(fd, JSON.stringify(report, null, 2) + "\n");
  console.log(`Repairs ${report.outcome}; report: ${reportPath}`);
  if (report.outcome === "failed") process.exitCode = 1;
} catch (error) {
  writeFileSync(fd, JSON.stringify({ mode, outcome: "failed", error: error instanceof Error ? error.message : String(error), steps: [] }, null, 2) + "\n");
  process.exitCode = 1;
} finally {
  closeSync(fd);
  await closeDb();
}
