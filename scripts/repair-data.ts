import { openSync, writeFileSync, closeSync } from "node:fs";
import { closeDb } from "@job-scout/db";
import { repairSteps, runDataRepairs, selectRepairSteps } from "../packages/core/src/repairs.js";

const args = process.argv.slice(2);
const mode = args.includes("--preview") ? "preview" : args.includes("--apply") ? "apply" : null;
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex >= 0 ? args[reportIndex + 1] : undefined;
const stepsIndex = args.indexOf("--steps");
const stepsArg = stepsIndex >= 0 ? args[stepsIndex + 1] : undefined;
const listOnly = args.length === 1 && args[0] === "--list";
if (listOnly) {
  console.log((await repairSteps()).map(step => `${step.name} (v${step.version})`).join("\n"));
  await closeDb();
  process.exit(0);
}
if (!mode || (args.includes("--preview") && args.includes("--apply")) || !reportPath || reportPath.startsWith("--")) {
  throw new Error("Usage: pnpm db:repair --list | (--preview | --apply) --report /private/path/report.json [--steps name,name]");
}
if (stepsIndex >= 0 && (!stepsArg || stepsArg.startsWith("--"))) throw new Error("--steps requires comma-separated repair names");
const selected = stepsArg === undefined ? undefined : selectRepairSteps(await repairSteps(), stepsArg.split(",").map(name => name.trim()));
// Refuse overwrite, create with private permissions before doing any database work.
const fd = openSync(reportPath, "wx", 0o600);
try {
  const report = await runDataRepairs(mode, selected);
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
