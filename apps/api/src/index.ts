import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, enableDbGauges, initMetrics, startMetricsServer } from "@job-scout/core";
import { log, setLogContext } from "@job-scout/shared";
import { createApp } from "./app.js";
import { env } from "./env.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function main() {
  setLogContext({ component: "api", version: env.version });
  initMetrics("api", env.version);
  // The API is the single replica that reports DB-truth gauges (queue depth, funnel, inbox…).
  enableDbGauges();
  startMetricsServer();
  await bootstrap();
  const app = createApp();

  if (env.isProd) {
    const dist = path.join(root, "apps/web/dist");
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist) || dist }));
    app.get("*", (c) => c.html(fs.readFileSync(path.join(dist, "index.html"), "utf8")));
  }

  if (env.embedWorker) {
    const { startWorker } = await import("../../worker/src/loop.js");
    startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY || 2) });
  }

  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
    log.info("api.listening", { url: `http://${info.address}:${info.port}`, mode: env.isProd ? "prod" : "dev", authMode: env.authMode, embedWorker: env.embedWorker });
  });

  if (!env.isProd) {
    // Dev: Vite middleware for apps/web, API routes stay on Hono.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      configFile: path.join(root, "apps/web/vite.config.ts"),
      server: { middlewareMode: true, hmr: { port: 24678 } },
      appType: "spa",
    });
    const httpServer = server as unknown as import("node:http").Server;
    const listeners = httpServer.listeners("request").slice() as Array<(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void>;
    httpServer.removeAllListeners("request");
    httpServer.on("request", (req, res) => {
      const url = req.url || "";
      const pathOnly = url.split("?")[0];
      if (url.startsWith("/api/") || url.startsWith("/mcp") || pathOnly === "/clip") {
        for (const l of listeners) l(req, res);
        return;
      }
      vite.middlewares(req, res, () => {
        for (const l of listeners) l(req, res);
      });
    });
  }
}

main().catch((e) => {
  log.error("api.fatal", { err: e });
  process.exit(1);
});
