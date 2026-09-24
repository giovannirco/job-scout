import { request } from "node:http";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { env } from "./env.js";
import { authMiddleware } from "./auth.js";
import { originMiddleware } from "./origin.js";

it("enforces the dev Host boundary on real HTTP requests without Origin", async () => {
  const originalMode = env.authMode;
  env.authMode = "dev";
  const app = new Hono();
  app.use("*", originMiddleware, authMiddleware);
  app.get("/api/v1/private", (c) => c.json({ profile: "synthetic-private-data" }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP address required");
    const get = (host: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: address.port, path: "/api/v1/private", headers: { host, "sec-fetch-site": "same-origin" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += String(chunk); });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject); req.end();
    });
    const denied = await get("rebinding.attacker.example");
    expect(denied.status).toBe(403); expect(denied.body).not.toContain("synthetic-private-data");
    const local = await get("localhost");
    expect(local.status).toBe(200); expect(local.body).toContain("synthetic-private-data");
  } finally {
    env.authMode = originalMode;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
