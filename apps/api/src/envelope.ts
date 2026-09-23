import type { Context } from "hono";
import { nanoid } from "nanoid";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INTERNAL"
  | "RATE_LIMITED"
  | "LLM_GATE";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INTERNAL: 500,
  RATE_LIMITED: 429,
  LLM_GATE: 409,
};

export function requestId(c: Context): string {
  return c.get("requestId") || nanoid(10);
}

export function ok<T>(c: Context, data: T, meta: Record<string, unknown> = {}, status = 200) {
  return c.json({ ok: true, data, meta: { requestId: requestId(c), ...meta } }, status as 200);
}

export function fail(c: Context, code: ErrorCode, message: string, details?: unknown, status?: number) {
  return c.json(
    { ok: false, error: { code, message, details: details ?? {} }, meta: { requestId: requestId(c) } },
    (status ?? STATUS[code]) as 400,
  );
}

export function queryMap(c: Context): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(c.req.query())) out[k] = v;
  return out;
}

export async function body<T = Record<string, unknown>>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}
