import type { Context } from "hono";
import * as core from "@job-scout/core";
import { fail } from "../envelope.js";

function asText(v: unknown): string {
  return v == null ? "" : String(v);
}

async function readClipPayload(c: Context): Promise<{ url: string; title: string; text: string }> {
  const qUrl = (c.req.query("url") || "").trim();
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    return { url: qUrl, title: "", text: "" };
  }
  const ct = (c.req.header("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return { url: asText(b.url || qUrl).trim(), title: asText(b.title), text: asText(b.text) };
  }
  const body = await c.req.parseBody();
  return { url: asText(body.url || qUrl).trim(), title: asText(body.title), text: asText(body.text) };
}

export async function handleClip(c: Context) {
  const payload = await readClipPayload(c);
  const url = payload.url;
  if (!url) return fail(c, "VALIDATION_ERROR", "url required");
  const title = payload.title;
  const text = payload.text;
  try {
    const snapshot = c.req.method === "POST";
    if (snapshot && !title.trim() && !text.trim()) return fail(c, "VALIDATION_ERROR", "snapshot empty");
    const r = snapshot ? await core.intakeClipSnapshot({ url, title, text }) : await core.intakeUrl(url);
    const slug = r.position.slug;
    if (!slug) throw new Error("position missing slug");
    return c.redirect(`/positions/${encodeURIComponent(slug)}`, 302);
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
}
