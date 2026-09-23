import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, getDriver } from "./client.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "db" });

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Apply drizzle-kit generated SQL migrations (packages/db/migrations).
 * Works for both node-postgres and PGlite backends.
 */
export async function runMigrations(): Promise<void> {
  const db = await getDb();
  const driver = getDriver();
  if (driver === "pg") {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMigrations()
    .then(async () => {
      log.info("db.migrations.applied");
      const { closeDb } = await import("./client.js");
      await closeDb();
    })
    .catch((e) => {
      log.error("db.migrations.failed", { err: e });
      process.exit(1);
    });
}
