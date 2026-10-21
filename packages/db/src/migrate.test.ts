import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getSql } from "./client.js";
import { MIGRATION_LOCK_KEY, migrateWithAdvisoryLock, runMigrations, type MigrationLockClient } from "./migrate.js";

function fakePool(opts: { failUnlock?: boolean } = {}) {
  const calls: string[] = [];
  const released: unknown[] = [];
  const client: MigrationLockClient = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push(`${sql} ${JSON.stringify(params ?? [])}`);
      if (opts.failUnlock && sql.includes("unlock")) throw new Error("connection lost");
      return { rows: [] };
    },
    release: (err?: Error | boolean) => {
      released.push(err);
    },
  };
  return { pool: { connect: async () => client }, client, calls, released };
}

describe("migrateWithAdvisoryLock", () => {
  it("locks, applies on the locked session, then unlocks and returns the client", async () => {
    const { pool, client, calls, released } = fakePool();
    let appliedOn: unknown = null;
    await migrateWithAdvisoryLock(pool, async (c) => {
      appliedOn = c;
      calls.push("apply");
    });
    expect(appliedOn).toBe(client);
    expect(calls).toEqual([
      `select pg_advisory_lock($1::bigint) ["${MIGRATION_LOCK_KEY}"]`,
      "apply",
      `select pg_advisory_unlock($1::bigint) ["${MIGRATION_LOCK_KEY}"]`,
    ]);
    expect(released).toEqual([undefined]);
  });

  it("unlocks and discards the connection when the migration fails", async () => {
    const { pool, calls, released } = fakePool();
    const boom = new Error("migration failed");
    await expect(migrateWithAdvisoryLock(pool, async () => { throw boom; })).rejects.toBe(boom);
    expect(calls.at(-1)).toContain("pg_advisory_unlock");
    expect(released).toEqual([boom]);
  });

  it("discards the connection when unlock fails, so the session lock cannot leak", async () => {
    const { pool, released } = fakePool({ failUnlock: true });
    await expect(migrateWithAdvisoryLock(pool, async () => {})).rejects.toThrow("connection lost");
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it("uses a fixed key that fits a Postgres bigint", () => {
    expect(BigInt(MIGRATION_LOCK_KEY) < 2n ** 63n).toBe(true);
  });
});

describe("runMigrations on PGlite", () => {
  const saved = { url: process.env.DATABASE_URL, dir: process.env.PGLITE_DATA_DIR };
  const dir = mkdtempSync(join(tmpdir(), "job-scout-migrate-"));

  beforeAll(async () => {
    await closeDb();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_DATA_DIR = dir;
  });

  afterAll(async () => {
    await closeDb();
    if (saved.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.url;
    if (saved.dir === undefined) delete process.env.PGLITE_DATA_DIR;
    else process.env.PGLITE_DATA_DIR = saved.dir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("two concurrent runs both succeed and apply each migration once", async () => {
    await expect(Promise.all([runMigrations(), runMigrations()])).resolves.toEqual([undefined, undefined]);
    const journal = JSON.parse(readFileSync(fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url)), "utf8")) as { entries: unknown[] };
    const sql = await getSql();
    const { rows } = await sql.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(rows[0].n).toBe(journal.entries.length);
  });
});
