import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { getDb, getDriver, getPool } from "./client.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "db" });

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

/**
 * Session-level advisory lock key that serializes migrations across processes (api, worker,
 * each CronJob, `pnpm db:migrate`). Fixed; a string so it never passes through a JS number.
 */
export const MIGRATION_LOCK_KEY = "7316150403962712161";

export interface MigrationLockClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(err?: Error | boolean): void;
}

/**
 * Check out one connection, hold `pg_advisory_lock` on it and run `apply` with that same
 * connection, so the lock and every migration statement share a session. The lock is always
 * released; if the migration or the unlock fails the connection is destroyed instead of being
 * returned to the pool, which ends the session and frees the lock.
 */
export async function migrateWithAdvisoryLock<C extends MigrationLockClient>(
  pool: { connect(): Promise<C> },
  apply: (client: C) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let failure: Error | undefined;
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_KEY]);
    try {
      await apply(client);
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
    }
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    client.release(failure);
  }
}

async function applyMigrations(): Promise<void> {
  const db = await getDb();
  const pool = getDriver() === "pg" ? getPool() : null;
  if (pool) {
    const [{ drizzle }, { migrate }] = await Promise.all([import("drizzle-orm/node-postgres"), import("drizzle-orm/node-postgres/migrator")]);
    // drizzle on a Pool would run each statement (and its transaction) on whichever pooled
    // connection is free; binding it to the locked client keeps everything on one session.
    await migrateWithAdvisoryLock<PoolClient>(pool, (client) => migrate(drizzle(client), { migrationsFolder }));
  } else if (getDriver() === "pg") {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  } else {
    // PGlite is a single in-process database: the in-process queue below serializes it.
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(db as Parameters<typeof migrate>[0], { migrationsFolder });
  }
}

let queue: Promise<void> = Promise.resolve();

/**
 * Apply drizzle-kit generated SQL migrations (packages/db/migrations).
 * Works for both node-postgres and PGlite backends. Calls in one process run one after
 * another; on Postgres a session-level advisory lock also serializes separate processes.
 */
export function runMigrations(): Promise<void> {
  const run = queue.then(applyMigrations);
  queue = run.catch(() => undefined);
  return run;
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
