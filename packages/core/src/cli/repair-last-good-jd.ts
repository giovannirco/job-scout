/**
 * Restore a clobbered JD from its last good revision. Dry-run by default; writes only with --apply.
 *
 *   pnpm db:repair-last-good-jd --presets /private/path/presets.json <name> [--apply]
 *   pnpm db:repair-last-good-jd --position <id> [--before <iso>] [--supersede-from <iso>] [--supersede-until <iso>] [--supersede ev_a,ev_b] [--apply]
 *   pnpm db:repair-last-good-jd --presets <file> <name> --snapshot <get_position.json>   # plan only, no database
 *
 * Presets name real positions, so they live outside the repository: a JSON object
 * { "<name>": { positionId, before?, supersedeFrom?, supersedeUntil?, supersedeEvaluations?, enqueue? } }.
 * --snapshot plans from a saved get_position (MCP/API) response and never opens a database.
 */
import { readFileSync } from "node:fs";
import type { LastGoodRepairPreset, RepairSnapshot } from "../jd-repair.js";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const presetsPath = flag("--presets");
const VALUE_FLAGS = new Set(["--presets", "--snapshot", "--position", "--before", "--supersede-from", "--supersede-until", "--supersede"]);
const name = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1]!)));
let preset: LastGoodRepairPreset | undefined;
if (presetsPath && name) {
  const all = JSON.parse(readFileSync(presetsPath, "utf8")) as Record<string, LastGoodRepairPreset>;
  if (!Object.hasOwn(all, name)) throw new Error(`unknown preset ${name}; known: ${Object.keys(all).join(", ")}`);
  preset = all[name];
} else if (flag("--position")) {
  preset = {
    positionId: flag("--position")!,
    before: flag("--before"),
    supersedeFrom: flag("--supersede-from"),
    supersedeUntil: flag("--supersede-until"),
    supersedeEvaluations: (flag("--supersede") || "").split(",").filter(Boolean),
  };
}
if (!preset) {
  console.error("usage: repair-last-good-jd (--presets <file> <name> | --position <id> …) [--snapshot <file>] [--apply]");
  process.exit(2);
}
const snapshotPath = flag("--snapshot");
if (snapshotPath) {
  if (argv.includes("--apply")) throw new Error("--snapshot plans only; it cannot --apply");
  const { planLastGoodRepair } = await import("../jd-repair.js");
  const raw = JSON.parse(readFileSync(snapshotPath, "utf8")) as RepairSnapshot["position"] & { revisions?: RepairSnapshot["revisions"]; evaluations?: RepairSnapshot["evaluations"] };
  if (raw.id !== preset.positionId) throw new Error(`snapshot is ${raw.id}, preset is ${preset.positionId}`);
  console.log(JSON.stringify({ dryRun: true, source: "snapshot", ...planLastGoodRepair({ position: raw, revisions: raw.revisions || [], evaluations: raw.evaluations || [] }, preset) }, null, 2));
} else {
  const { closeDb } = await import("@job-scout/db");
  const { repairToLastGoodRevision } = await import("../jd-repair.js");
  try {
    console.log(JSON.stringify(await repairToLastGoodRevision(preset, { apply: argv.includes("--apply") }), null, 2));
  } finally {
    await closeDb();
  }
}
