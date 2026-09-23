import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { CHAT_SCOPES, type ChatScope } from "@job-scout/db";
import { createThread, deleteThread, getPosition, getCompany, getThread, listThreads, runChatTurn, LlmGateError } from "@job-scout/core";
import { body, fail, ok } from "../envelope.js";

export const chatRoutes = new Hono();

/** GET /threads?scope=position&positionId=… */
chatRoutes.get("/threads", async (c) => {
  const scope = c.req.query("scope") as ChatScope | undefined;
  if (scope && !CHAT_SCOPES.includes(scope)) return fail(c, "VALIDATION_ERROR", `scope must be one of ${CHAT_SCOPES.join(", ")}`);
  return ok(
    c,
    await listThreads({
      scope,
      positionId: c.req.query("positionId") || null,
      companyId: c.req.query("companyId") || null,
      limit: Number(c.req.query("limit") || 30),
    }),
  );
});

chatRoutes.post("/threads", async (c) => {
  const b = (await body(c)) as { scope?: ChatScope; positionId?: string; companyId?: string; title?: string };
  const scope = b.scope ?? "global";
  if (!CHAT_SCOPES.includes(scope)) return fail(c, "VALIDATION_ERROR", "bad scope");
  let positionId: string | null = null;
  let companyId: string | null = null;
  if (scope === "position") {
    const pos = b.positionId ? await getPosition(b.positionId) : null;
    if (!pos) return fail(c, "NOT_FOUND", "position not found");
    positionId = pos.id;
    companyId = pos.companyId;
  } else if (scope === "company") {
    const co = b.companyId ? await getCompany(b.companyId) : null;
    if (!co) return fail(c, "NOT_FOUND", "company not found");
    companyId = co.id;
  }
  return ok(c, await createThread({ scope, positionId, companyId, title: b.title ?? null }), {}, 201);
});

chatRoutes.get("/threads/:id", async (c) => {
  const t = await getThread(c.req.param("id"));
  return t ? ok(c, t) : fail(c, "NOT_FOUND", "thread not found");
});

chatRoutes.delete("/threads/:id", async (c) => ok(c, await deleteThread(c.req.param("id"))));

/**
 * POST /threads/:id/messages { text } → SSE stream of ChatEvent.
 * Events: delta | tool_call | tool_result | message | done | error
 */
chatRoutes.post("/threads/:id/messages", async (c) => {
  const threadId = c.req.param("id");
  const b = (await body(c)) as { text?: string };
  const text = (b.text || "").trim();
  if (!text) return fail(c, "VALIDATION_ERROR", "text is required");
  if (!(await getThread(threadId))) return fail(c, "NOT_FOUND", "thread not found");

  return streamSSE(c, async (stream) => {
    let seq = 0;
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data), id: String(++seq) });
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
    const ctrl = new AbortController();
    stream.onAbort(() => ctrl.abort());
    try {
      await runChatTurn(threadId, text, (e) => void send(e.type, e), { signal: ctrl.signal });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await send("error", { type: "error", message: e instanceof LlmGateError ? `${msg} (Settings › AI › chat)` : msg });
    } finally {
      clearInterval(ping);
    }
  });
});
