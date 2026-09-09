import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema.ts",
  out: "./packages/db/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgresql://localhost:5432/job_scout_v2",
  },
  strict: true,
  verbose: true,
});
