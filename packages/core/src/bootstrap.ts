import { and, eq, isNull, ne, or } from "drizzle-orm";
import { boardSources, closeDb, getDb, id, profiles, runMigrations } from "@job-scout/db";
import { FULL_CATALOG } from "@job-scout/shared";
import { getProfile, alignStarterGateWithRoles } from "./profile.js";
import { getSettings } from "./settings.js";

export async function closeDbSafe() {
  try { await closeDb(); } catch { /* shutdown best effort */ }
}

/** Startup migrates the schema and seeds new installs. Existing data repairs are explicit. */
export async function bootstrap(opts: { seedBoards?: boolean } = {}) {
  await runMigrations();
  const db = await getDb();
  const existing = (await db.select({ id: profiles.id }).from(profiles).limit(1)).at(0);
  await getProfile();
  await getSettings({ fresh: true });
  if (!existing) {
    await alignStarterGateWithRoles();
    if (opts.seedBoards !== false) await syncBoardCatalog();
  }
}

/** Called on a fresh installation or by the audited upgrade runner. */
export async function syncBoardCatalog() {
  const db = await getDb();
  const oldRemoteOk = and(eq(boardSources.provider, "market"), eq(boardSources.token, "remoteok"));
  const currentRemoteOk = (await db.select({ id: boardSources.id }).from(boardSources)
    .where(and(eq(boardSources.provider, "remoteok"), eq(boardSources.token, "remoteok"))).limit(1)).at(0);
  if (currentRemoteOk) {
    // Keep the legacy source and its history; stop scheduling the duplicate.
    await db.update(boardSources).set({ enabled: false, capability: "manual_watch" }).where(oldRemoteOk);
  } else {
    await db.update(boardSources).set({ provider: "remoteok", capability: "list_api", enabled: true, sourceKind: "market" }).where(oldRemoteOk);
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

  const { reconcileBoardSources } = await import("./board-reconcile.js");
  return reconcileBoardSources({ dryRun: false });
}
