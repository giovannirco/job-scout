import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { boardSources, closeDb, getDb, id, runMigrations } from "@job-scout/db";

export async function closeDbSafe() {
  try {
    await closeDb();
  } catch {
    /* ignore */
  }
}
import { FULL_CATALOG } from "@job-scout/shared";
import { getProfile, alignStarterGateWithRoles } from "./profile.js";
import { getSettings } from "./settings.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "bootstrap" });

/** Migrate + seed profile/settings and sync the board catalog (insert-missing + promote list_api). */
export async function bootstrap(opts: { seedBoards?: boolean } = {}) {
  await runMigrations();
  await getProfile();
  await getSettings({ fresh: true });
  const aligned = await alignStarterGateWithRoles();
  if (aligned) log.info("bootstrap.gate.from-roles", { titleInclude: aligned });
  if (process.env.PGLITE_DATA_DIR && process.env.NODE_ENV !== "production") {
    /* tests skip deploy backfill */
  } else {
    const { repairPositionData } = await import("./data-repair.js");
    await repairPositionData({ dryRun: false })
      .then(r => log.info("bootstrap.position-repair", { count: r.count }))
      .catch(e => log.error("bootstrap.position-repair.failed", { err: e }));
    const { backfillListingFacts } = await import("./listing-classify.js");
    await backfillListingFacts()
      .then((r) => log.info("bootstrap.listing-facts", r))
      .catch((e) => log.error("bootstrap.listing-facts.failed", { err: e }));
    const { getSettings, updateSettings } = await import("./settings.js");
    const { repairMisstampedDiscoveryFilings } = await import("./scan.js");
    const stored = await getSettings({ fresh: true });
    if (stored.misstampWithdrawVersion !== "1") {
      await repairMisstampedDiscoveryFilings()
        .then(async (r) => {
          await updateSettings({ misstampWithdrawVersion: "1" });
          log.info("bootstrap.misstamp-withdraw", r);
        })
        .catch((e) => log.error("bootstrap.misstamp-withdraw.failed", { err: e }));
    }
  }
  const db = await getDb();
  if (opts.seedBoards !== false) {
    const remoteOk = (
      await db
        .select({ id: boardSources.id })
        .from(boardSources)
        .where(and(eq(boardSources.provider, "remoteok"), eq(boardSources.token, "remoteok")))
        .limit(1)
    )[0];
    if (remoteOk) {
      await db
        .delete(boardSources)
        .where(and(eq(boardSources.provider, "market"), eq(boardSources.token, "remoteok")));
    } else {
      await db
        .update(boardSources)
        .set({
          provider: "remoteok",
          capability: "list_api",
          enabled: true,
          sourceKind: "market",
        })
        .where(and(eq(boardSources.provider, "market"), eq(boardSources.token, "remoteok")));
    }
    for (const e of FULL_CATALOG) {
      await db
        .insert(boardSources)
        .values({
          id: id("bs"),
          company: e.company,
          provider: e.provider,
          token: e.token,
          careersUrl: e.careersUrl,
          enabled: e.capability === "list_api",
          sourceKind: e.sourceKind,
          tags: e.tags,
          notes: e.notes ?? null,
          capability: e.capability,
        })
        .onConflictDoNothing();
    }
    for (const e of FULL_CATALOG.filter((x) => x.capability === "list_api")) {
      await db
        .update(boardSources)
        .set({
          capability: "list_api",
          enabled: true,
          sourceKind: e.sourceKind,
          tags: e.tags,
          notes: e.notes ?? null,
          careersUrl: e.careersUrl,
        })
        .where(
          and(
            eq(boardSources.provider, e.provider),
            eq(boardSources.token, e.token),
            or(isNull(boardSources.capability), ne(boardSources.capability, "list_api"))!,
          ),
        );
    }
    // Verified ATS migrations (#18). Runs after the catalog sync so a catalog row
    // re-inserted under the old token is corrected in the same boot.
    const { reconcileBoardSources } = await import("./board-reconcile.js");
    await reconcileBoardSources({ dryRun: false })
      .then((r) => { if (r.count || r.conflicts.length) log.info("bootstrap.boards.reconciled", { migrated: r.migrated.length, demoted: r.demoted.length, conflicts: r.conflicts.length }); })
      .catch((e) => log.error("bootstrap.boards.reconcile.failed", { err: e }));
    const n = (await db.select({ c: sql<number>`count(*)::int` }).from(boardSources))[0]?.c ?? 0;
    log.info("bootstrap.boards.synced", { catalog: FULL_CATALOG.length, boards: n });
    const { alignCompanyCareersFromBoards } = await import("./companies.js");
    await alignCompanyCareersFromBoards()
      .then((r) => { if (r.updated) log.info("bootstrap.company-careers", r); })
      .catch((e) => log.error("bootstrap.company-careers.failed", { err: e }));
  }
}
