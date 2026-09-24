import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@job-scout/core", () => ({
  createThread: vi.fn(), deleteThread: vi.fn(), getPosition: vi.fn(), getCompany: vi.fn(), listThreads: vi.fn(),
  getThread: vi.fn(async () => ({ id: "thread" })),
  LlmGateError: class extends Error {},
  runChatTurn: vi.fn(async (_id: string, _text: string, emit: (event: unknown) => void) => {
    emit({ type: "delta", text: "hello" });
    emit({ type: "message", message: { content: "hello" } });
    emit({ type: "done", threadId: "thread", steps: 1, tokensIn: 1, tokensOut: 1 });
  }),
}));

import { chatRoutes } from "./chat.js";

describe("chat SSE completion", () => {
  it("flushes every queued event, including done, before closing the response", async () => {
    const app = new Hono().route("/chat", chatRoutes);
    const response = await app.request("/chat/threads/thread/messages", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    const events = (await response.text()).split("\n").filter(line => line.startsWith("event:"));
    expect(events).toEqual(["event: delta", "event: message", "event: done"]);
  });
});
