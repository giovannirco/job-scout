import { getTableName, is, sql } from "drizzle-orm";
import { getDb, getDriver, withDbContext, type Db } from "@job-scout/db";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@job-scout/db";
import { getSettings, invalidateSettingsCache, updateSettings } from "./settings.js";

export type RepairStep = { name: string; version: string; run: () => Promise<unknown> };

/** Select explicitly named steps in canonical order, rejecting typos before any writes. */
export function selectRepairSteps(plan: RepairStep[], names: string[]): RepairStep[] {
  if (!names.length || names.some(name => !plan.some(step => step.name === name))) {
    throw new Error(`Unknown or empty repair selection; available steps: ${plan.map(step => step.name).join(", ")}`);
  }
  return plan.filter(step => names.includes(step.name));
}
export type RowChange = { table: string; id: string; operation: "insert" | "update" | "delete"; before: Record<string, unknown> | null; after: Record<string, unknown> | null };
export type RepairReport = {
  mode: "preview" | "apply";
  outcome: "previewed" | "applied" | "failed";
  steps: { name: string; version: string; status: "pending" | "skipped" | "ok" | "failed"; result?: unknown; error?: string; changes: RowChange[] }[];
  error?: string;
};

export async function repairSteps(): Promise<RepairStep[]> {
  const scan = await import("./scan.js");
  const pos = await import("./positions.js");
  const { syncBoardCatalog } = await import("./bootstrap.js");
  const { alignStarterGateWithRoles } = await import("./profile.js");
  const { repairPositionData } = await import("./data-repair.js");
  const { backfillListingFacts } = await import("./listing-classify.js");
  const { settleExpectedQueueFailures } = await import("./jobs.js");
  const { alignCompanyCareersFromBoards } = await import("./companies.js");
  // New independent markers intentionally rerun legacy steps once: older boot
  // markers could be written despite partial fetch failures. No text-based dedupe.
  return [
    ["board-catalog", syncBoardCatalog],
    ["starter-gate", alignStarterGateWithRoles],
    ["position-data", () => repairPositionData({ dryRun: false })],
    ["listing-facts", () => backfillListingFacts({ force: true })],
    ["misstamp-withdraw", scan.repairMisstampedDiscoveryFilings],
    ["office-gate", scan.repairOfficeDiscoveryFilings],
    ["gate-lanes", scan.syncGateArchiveLanes],
    ["home-gate", scan.repairHomeMarketFilings],
    ["profile-gate", scan.repairProfileGateFilings],
    ["titles", pos.trimStoredTitles],
    ["blank-greenhouse", scan.refetchBlankGreenhouseFilings],
    ["role-phrase", scan.regateRecentDiscovery],
    ["junk-place", scan.refetchJunkPlaceFilings],
    ["archived-discovery", scan.filterPassedDiscoveryForArchived],
    ["us-place-geo", scan.reclassifyUsPlaceLists],
    ["salary-object", pos.repairObjectSalaries],
    ["region-office", scan.refetchDisagreeingRegions],
    ["labels", scan.refreshListingLabels],
    ["offices", pos.expandStoredOfficeLocations],
    ["entities", pos.decodeStoredJdEntities],
    ["expected-queue-failures", settleExpectedQueueFailures],
    ["change-times", pos.repairSnapshotChangeTimes],
    ["changed-badges", pos.clearRepairedChangedBadges],
    ["company-careers", alignCompanyCareersFromBoards],
  ].map(([name, run]) => ({ name: name as string, version: "1", run: run as RepairStep["run"] }));
}

type Snapshot = Map<string, Map<string, Record<string, unknown>>>;
async function snapshot(db: Db): Promise<Snapshot> {
  const out: Snapshot = new Map();
  for (const table of (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable))) {
    const rows = await db.select().from(table);
    out.set(getTableName(table), new Map(rows.map(row => {
      const value = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      return [String(value.id), value];
    })));
  }
  return out;
}

function changesBetween(before: Snapshot, after: Snapshot): RowChange[] {
  const changes: RowChange[] = [];
  for (const [table, rows] of after) {
    const prior = before.get(table) || new Map<string, Record<string, unknown>>();
    for (const id of new Set([...prior.keys(), ...rows.keys()])) {
      const a = prior.get(id), b = rows.get(id);
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const fields = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      const changed = [...fields].filter(k => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
      changes.push({ table, id, operation: !a ? "insert" : !b ? "delete" : "update",
        before: a ? Object.fromEntries(changed.map(k => [k, a[k]])) : null,
        after: b ? Object.fromEntries(changed.map(k => [k, b[k]])) : null });
    }
  }
  return changes;
}

/** Run only with API/workers stopped, after schema migration, preferably on a restored copy.
 * Preview executes the real helpers then rolls back every database write, including
 * queued jobs and version markers. Remote ATS reads cannot be rolled back.
 */
export async function runDataRepairs(mode: "preview" | "apply", steps?: RepairStep[]): Promise<RepairReport> {
  const plan = steps || await repairSteps();
  const report: RepairReport = { mode, outcome: mode === "preview" ? "previewed" : "applied",
    steps: plan.map(s => ({ name: s.name, version: s.version, status: "pending", changes: [] })) };
  const rollbackPreview = new Error("preview rollback");
  const db = await getDb();
  try {
    await db.transaction(async tx => withDbContext(tx as unknown as Db, async () => {
      if (getDriver() === "pg") {
        await tx.execute(sql`select pg_advisory_xact_lock(187617, 112)`);
      }
      invalidateSettingsCache();
      const versions = { ...(await getSettings({ fresh: true })).repairVersions };
      let before = await snapshot(tx as unknown as Db);
      for (const [i, step] of plan.entries()) {
        const entry = report.steps[i]!;
        if (versions[step.name] === step.version) { entry.status = "skipped"; continue; }
        try {
          entry.result = await step.run();
          const after = await snapshot(tx as unknown as Db);
          entry.changes = changesBetween(before, after);
          before = after;
          const failed = (entry.result as { failed?: number } | null)?.failed;
          if (failed) throw new Error(`${failed} row(s) failed; see result.failedIds`);
          entry.status = "ok";
          versions[step.name] = step.version;
        } catch (error) {
          entry.status = "failed";
          entry.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
      if (report.steps.some(s => s.status === "ok")) await updateSettings({ repairVersions: versions });
      if (mode === "preview") throw rollbackPreview;
    }));
  } catch (error) {
    if (error !== rollbackPreview) {
      report.outcome = "failed";
      report.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    // Transaction-local settings must never escape a rollback or failed apply.
    invalidateSettingsCache();
  }
  return report;
}
