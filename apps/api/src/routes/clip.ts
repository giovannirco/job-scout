import { html } from "hono/html";
import { CLIP_TEXT_MAX } from "@job-scout/shared";
import { allowedOrigin } from "../origin.js";
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
    if (!r.position) throw new Error("position missing");
    const slug = r.position.slug;
    if (!slug) throw new Error("position missing slug");
    return c.redirect(`/positions/${encodeURIComponent(slug)}`, 302);
  } catch (e) {
    return fail(c, "VALIDATION_ERROR", e instanceof Error ? e.message : String(e));
  }
}

/** Cross-site bookmarklets stage an escaped preview; only a same-origin confirmation writes. */
export async function clipPreview(c: Context, next: import("hono").Next) {
  const origin = c.req.header("origin");
  const crossSite = ["cross-site", "same-site"].includes(c.req.header("sec-fetch-site") || "");
  if ((!origin || allowedOrigin(origin)) && !crossSite) return next();
  if (!["GET", "POST"].includes(c.req.method)) return fail(c, "FORBIDDEN", "Origin is not allowed");
  const payload = await readClipPayload(c);
  if (!payload.url || payload.url.length > 8192 || payload.title.length > 2000 || payload.text.length > CLIP_TEXT_MAX) {
    return fail(c, "VALIDATION_ERROR", "Clip is empty or too large");
  }
  try {
    const url = new URL(payload.url);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid URL");
  } catch {
    return fail(c, "VALIDATION_ERROR", "HTTP(S) URL required");
  }
  c.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Confirm job clip</title></head><body>
    <h1>Save this job to Job Scout?</h1><p>${payload.title || payload.url}</p><p>${payload.url}</p>
    <p>Confirm this clip to add it to your desk. You must already be signed in to Job Scout.</p>
    <form method="${c.req.method}" action="/clip">
      <input type="hidden" name="url" value="${payload.url}">
      <input type="hidden" name="title" value="${payload.title}">
      <input type="hidden" name="text" value="${payload.text}">
      <button type="submit">Save job clip</button>
    </form></body></html>`);
}
