import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };

export default defineConfig({
  root: here,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.join(here, "src"),
      "@desk-ui/api-client": path.join(repo, "packages/desk-ui/api-client/src/index.ts"),
      "@job-scout/shared": path.join(repo, "packages/shared/src/index.ts"),
    },
  },
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8080", "/mcp": "http://127.0.0.1:8080", "/clip": "http://127.0.0.1:8080" },
  },
});
