import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema.js";
import { log as rootLog } from "@job-scout/shared";
const log = rootLog.child({ scope: "db" });

export type Db = ReturnType<typeof drizzlePglite<typeof schema>> | ReturnType<typeof drizzlePg<typeof schema>>;

let _db: Db | null = null;
let _pglite: PGlite | null = null;
let _pool: pg.Pool | null = null;

function dataDir() {
  const dir = process.env.PGLITE_DATA_DIR || path.join(process.cwd(), ".data", "pglite");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDriver(): "pg" | "pglite" {
  const url = process.env.DATABASE_URL;
  return url && !url.startsWith("pglite:") ? "pg" : "pglite";
}

export async function getDb(): Promise<Db> {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (url && !url.startsWith("pglite:")) {
    // CNPG / internal cluster certs are not public CAs — never verify-full by default.
    const useSsl =
      process.env.PGSSL !== "0" &&
      process.env.PGSSL !== "false" &&
      (process.env.PGSSL === "1" ||
        /sslmode=/i.test(url) ||
        url.includes(".svc") ||
        url.includes("postgres-platform") ||
        url.includes("cnpg"));
    const cleanUrl = url
      .replace(/([?&])sslmode=[^&]*/gi, "$1")
      .replace(/[?&]$/, "")
      .replace(/\?&/, "?");
    _pool = new pg.Pool({
      connectionString: cleanUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: Number(process.env.PG_POOL_MAX || 8),
      // 0 disables idle disconnects (useful over kubectl port-forward, which dies on resets)
      idleTimeoutMillis: process.env.PG_IDLE_MS ? Number(process.env.PG_IDLE_MS) : 10_000,
    });
    // Idle clients can be dropped by the server / a proxy; without a handler this is an uncaught error.
    _pool.on("error", (err) => log.error("db.pool.error", { err }));
    _db = drizzlePg(_pool, { schema });
    return _db;
  }

  _pglite = new PGlite(dataDir());
  await _pglite.waitReady;
  _db = drizzlePglite(_pglite, { schema });
  return _db;
}

export async function getSql(): Promise<{
  exec: (sql: string) => Promise<unknown>;
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}> {
  await getDb();
  if (_pglite) {
    return {
      exec: async (sql: string) => _pglite!.exec(sql),
      query: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const res = await _pglite!.query<T>(sql, params);
        return { rows: res.rows as T[] };
      },
    };
  }
  if (_pool) {
    return {
      exec: async (sql: string) => {
        await _pool!.query(sql);
      },
      query: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const res = await _pool!.query(sql, params);
        return { rows: res.rows as T[] };
      },
    };
  }
  throw new Error("database not initialized");
}

/** pg pool counters for metrics (zeros on PGlite). */
export function poolStats(): { total: number; idle: number; waiting: number } {
  return _pool ? { total: _pool.totalCount, idle: _pool.idleCount, waiting: _pool.waitingCount } : { total: 0, idle: 0, waiting: 0 };
}

export async function closeDb() {
  if (_pool) await _pool.end();
  if (_pglite) await _pglite.close();
  _db = null;
  _pool = null;
  _pglite = null;
}

export { schema };
