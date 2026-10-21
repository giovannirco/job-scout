import { createHash } from "node:crypto";

/**
 * Opaque page cursors for list endpoints. A cursor names the sort and the
 * filters it was issued for, so it cannot be replayed against another query,
 * plus either a keyset position (timestamp text at full database precision and
 * the row id) or an offset for sorts with no usable keyset.
 */
export type ListCursor = { v: 1; s: string; f: string; k?: [string, string]; o?: number };

/** timestamptz::text, e.g. 2026-01-02 03:04:05.123456+00 */
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2}){0,2})?$/;

export class CursorError extends Error {
  readonly code = "invalid_cursor";
}

export function filterFingerprint(filters: Record<string, unknown>): string {
  const stable = Object.keys(filters).sort().filter((k) => filters[k] !== undefined && filters[k] !== null && filters[k] !== "").map((k) => [k, String(filters[k])]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 16);
}

export function encodeCursor(c: Omit<ListCursor, "v">): string {
  return Buffer.from(JSON.stringify({ v: 1, ...c })).toString("base64url");
}

export function decodeCursor(raw: string, expect: { s: string; f: string }): ListCursor {
  let c: Partial<ListCursor> | null = null;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ListCursor>;
  } catch {
    c = null;
  }
  if (!c || c.v !== 1 || typeof c.s !== "string" || typeof c.f !== "string") throw new CursorError("invalid cursor: pass nextCursor exactly as returned");
  if (c.s !== expect.s || c.f !== expect.f) throw new CursorError("cursor was issued for a different sort or filters: repeat the original arguments with it, or start again without cursor");
  const keyed = Array.isArray(c.k) && c.k.length === 2 && c.k.every((x) => typeof x === "string") && PG_TIMESTAMP.test(c.k[0]);
  const offset = typeof c.o === "number" && Number.isInteger(c.o) && c.o >= 0;
  if (!keyed && !offset) throw new CursorError("invalid cursor: pass nextCursor exactly as returned");
  return c as ListCursor;
}
