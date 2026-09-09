import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@job-scout/shared": path.resolve("packages/shared/src"),
      "@job-scout/db": path.resolve("packages/db/src"),
      "@job-scout/ats": path.resolve("packages/ats/src"),
      "@job-scout/llm": path.resolve("packages/llm/src"),
      "@job-scout/core": path.resolve("packages/core/src"),
    },
  },
});
