import fs from "node:fs";
import type pg from "pg";

/** Do not let URL sslmode override certificate validation passed to node-postgres. */
export function postgresConfig(connectionString: string, source: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode && !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslMode)) throw new Error("Unsupported PostgreSQL sslmode");
  const disabled = source.PGSSL === "0" || source.PGSSL === "false" || (!source.PGSSL && sslMode === "disable");
  const caFile = source.PGSSLROOTCERT || url.searchParams.get("sslrootcert");
  const ca = source.PGSSL_CA || (caFile ? fs.readFileSync(caFile, "utf8") : undefined);
  // Reject options that node-postgres otherwise merges into / replaces our TLS policy.
  for (const key of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl: disabled ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: Number(source.PG_POOL_MAX || 8),
    idleTimeoutMillis: source.PG_IDLE_MS ? Number(source.PG_IDLE_MS) : 10_000,
  };
}
