import { describe, expect, it } from "vitest";
import { postgresConfig } from "./pg-config.js";

describe("PostgreSQL TLS configuration", () => {
  it("authenticates the database certificate by default, including require/verify-full URLs", () => {
    for (const query of ["", "?sslmode=require", "?sslmode=verify-full", "?sslmode=allow&ssl=true&uselibpqcompat=true"]) {
      const config = postgresConfig(`postgresql://user:pass@db.example/app${query}`, {});
      expect(config.ssl).toEqual({ rejectUnauthorized: true });
      expect(config.connectionString).not.toMatch(/sslmode|uselibpqcompat|ssl=/);
    }
  });
  it("requires an explicit opt-out for plaintext local Postgres", () => {
    expect(postgresConfig("postgresql://localhost/app", { PGSSL: "0" }).ssl).toBe(false);
    expect(postgresConfig("postgresql://localhost/app?sslmode=disable", {}).ssl).toBe(false);
    expect(postgresConfig("postgresql://localhost/app?sslmode=disable", { PGSSL: "1" }).ssl).toEqual({ rejectUnauthorized: true });
  });
  it("fails closed when a supplied private CA file is missing", () => {
    expect(() => postgresConfig("postgresql://db.example/app", { PGSSLROOTCERT: "/missing/job-scout-ca.crt" })).toThrow();
  });
});
