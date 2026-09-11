import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { getDb } from "@job-scout/db";
import { httpDuration, httpRequests, metricRoute } from "@job-scout/core";
import { log as rootLog } from "@job-scout/shared";
import { sql } from "drizzle-orm";
import { authMiddleware, authStatus, loginHandler } from "./auth.js";
import { env } from "./env.js";
import { fail, ok } from "./envelope.js";
import { handleMcpHttp } from "./mcp/handler.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { chatRoutes } from "./routes/chat.js";
import { companiesRoutes } from "./routes/companies.js";
import { positionsRoutes } from "./routes/positions.js";
import { radarRoutes } from "./routes/radar.js";
import { settingsRoutes } from "./routes/settings.js";
import { todayRoutes } from "./routes/today.js";
import { interviewsDeskRoutes, processesRoutes } from "./routes/process.js";
import { handleClip } from "./routes/clip.js";

const log = rootLog.child({ scope: "http" });
const QUIET_PATHS = new Set(["/api/v1/health", "/api/v1/ready", "/metrics", "/favicon.ico"]);

export function createApp() {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-request-id") || nanoid(10);
    c.set("requestId", requestId);
    const t0 = performance.now();
    await next();
    const ms = performance.now() - t0;
    const path = c.req.path;
    // Static assets / SPA shell are not API traffic: skip metrics + logs.
    const isApi = path.startsWith("/api/") || path.startsWith("/mcp");
    if (!isApi) return;
    const route = metricRoute(c.req.routePath, path);
    const status = c.res.status;
    httpRequests.labels({ method: c.req.method, route, status: String(status) }).inc();
    httpDuration.labels({ method: c.req.method, route }).observe(ms / 1000);
    c.res.headers.set("x-request-id", requestId);
    if (QUIET_PATHS.has(path) && status < 400) return;
    const user = c.get("user") as { kind?: string; name?: string } | undefined;
    const fields = {
      requestId,
      method: c.req.method,
      path,
      route,
      status,
      ms: Math.round(ms * 10) / 10,
      userKind: user?.kind,
      user: user?.name,
      mcpMethod: c.req.header("mcp-method") || undefined,
      ua: c.req.header("user-agent")?.slice(0, 80),
    };
    if (status >= 500) log.error("http.request", fields);
    else if (status >= 400) log.warn("http.request", fields);
    else log.info("http.request", fields);
  });
  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version", "Mcp-Method", "Mcp-Name", "Last-Event-ID"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );
  app.use("/api/*", authMiddleware);
  app.use("/clip", authMiddleware);
  app.get("/clip", handleClip);
  app.post("/clip", handleClip);

  app.get("/api/v1/health", (c) => ok(c, { status: "ok", version: env.version }));
  app.get("/api/v1/ready", async (c) => {
    try {
      const db = await getDb();
      await db.execute(sql`select 1`);
      return ok(c, { ready: true });
    } catch (e) {
      return fail(c, "INTERNAL", e instanceof Error ? e.message : String(e), {}, 503);
    }
  });
  app.post("/api/v1/auth/login", loginHandler);
  app.get("/api/v1/auth/status", authStatus);

  app.route("/api/v1/today", todayRoutes);
  app.route("/api/v1/interviews", interviewsDeskRoutes);
  app.route("/api/v1/processes", processesRoutes);
  app.route("/api/v1/positions", positionsRoutes);
  app.route("/api/v1/companies", companiesRoutes);
  app.route("/api/v1/radar", radarRoutes);
  app.route("/api/v1/settings", settingsRoutes);
  app.route("/api/v1/approvals", approvalsRoutes);
  app.route("/api/v1/chat", chatRoutes);

  app.onError((err, c) => {
    log.error("http.unhandled", { requestId: c.get("requestId"), method: c.req.method, path: c.req.path, err });
    return fail(c, "INTERNAL", err.message);
  });
  app.notFound((c) => (c.req.path.startsWith("/api/") ? fail(c, "NOT_FOUND", `no route ${c.req.method} ${c.req.path}`) : c.text("not found", 404)));

  const mcp = async (c: { req: { method: string; json: () => Promise<unknown>; raw: Request } }) => {
    let parsed: unknown;
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      try {
        parsed = await c.req.json();
      } catch {
        parsed = undefined;
      }
    }
    return handleMcpHttp(c.req.raw, parsed);
  };
  app.all("/mcp", mcp);
  app.all("/mcp/*", mcp);

  return app;
}
