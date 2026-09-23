// Namespace import, deliberately: `import { createHash }` binds the named export at
// module-evaluation time, and Vite's browser stub for a Node builtin throws on any
// property access. apps/web imports this package's barrel, so a named import takes
// the whole SPA down in dev (production survives only because Rollup tree-shakes it).
// A namespace import defers the property access to call time, which never happens
// in the browser.
import * as nodeCrypto from "node:crypto";
import type { ChangeKind, FieldDiff } from "./types.js";

export function normalizeDescription(text: string): string {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase();
}

/** Decode common HTML entities (up to 2 passes for double-escaped ATS dumps). */
export function decodeBasicEntities(text: string): string {
  let s = text || "";
  for (let i = 0; i < 2; i++) {
    if (!/&(?:lt|gt|amp|quot|nbsp|#\d+|#x[0-9a-f]+);/i.test(s)) break;
    s = s
      .replace(/&nbsp;/gi, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) ? String.fromCharCode(code) : _;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return s;
}

/**
 * Plain-text compare key for JD bodies: strip tags/entities so HTML cleanup
 * is not treated as a material content change.
 */
export function stripMarkupForCompare(text: string): string {
  let s = decodeBasicEntities(text || "");
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeBasicEntities(s);
  return normalizeDescription(s);
}

export function isFormattingOnlyTextChange(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return stripMarkupForCompare(before || "") === stripMarkupForCompare(after || "");
}

/** Stable content hash for JD snapshots (title + body + salary + location). */
export function contentHash(parts: {
  title?: string | null;
  descriptionText?: string | null;
  salaryRaw?: string | null;
  locationRaw?: string | null;
}): string {
  const payload = [
    normalizeDescription(parts.title || ""),
    normalizeDescription(parts.descriptionText || ""),
    normalizeDescription(parts.salaryRaw || ""),
    normalizeDescription(parts.locationRaw || ""),
  ].join("\n||\n");
  return nodeCrypto.createHash("sha256").update(payload).digest("hex");
}

export function shortHash(hex: string, len = 16): string {
  return hex.slice(0, len);
}

export function fieldDiffs(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  paths: string[],
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  for (const path of paths) {
    const b = before[path];
    const a = after[path];
    const bs = b == null || b === "" ? null : String(b);
    const as = a == null || a === "" ? null : String(a);
    if (bs !== as) {
      diffs.push({ path, before: bs, after: as });
    }
  }
  return diffs;
}

const MATERIAL_PATHS = new Set([
  "title",
  "salary_raw",
  "salary_min",
  "salary_max",
  "salary_currency",
  "location_raw",
  "geo_class",
  "remote_class",
  "listing_status",
]);

/** Heuristic: title/comp/geo/requirements changes are material; tiny body churn is noise. */
export function classifyMateriality(
  diffs: FieldDiff[],
  opts?: { forceKind?: ChangeKind },
): { material: boolean; change_kind: ChangeKind } {
  if (opts?.forceKind === "noise_rebase") {
    return { material: false, change_kind: "noise_rebase" };
  }
  if (opts?.forceKind === "first_seen") {
    return { material: true, change_kind: "first_seen" };
  }
  if (opts?.forceKind === "closed") {
    return { material: true, change_kind: "closed" };
  }

  if (!diffs.length) {
    return { material: false, change_kind: "noise_rebase" };
  }

  const paths = new Set(diffs.map((d) => d.path));
  if (paths.has("title")) return { material: true, change_kind: "title" };
  if (
    paths.has("salary_raw") ||
    paths.has("salary_min") ||
    paths.has("salary_max") ||
    paths.has("salary_currency")
  ) {
    return { material: true, change_kind: "comp" };
  }
  if (paths.has("location_raw") || paths.has("geo_class") || paths.has("remote_class")) {
    return { material: true, change_kind: "geo" };
  }
  if (paths.has("listing_status")) {
    const d = diffs.find((x) => x.path === "listing_status");
    if (d?.after === "closed") return { material: true, change_kind: "closed" };
    if (d?.before === "closed" && d?.after === "open")
      return { material: true, change_kind: "reopened" };
    return { material: true, change_kind: "status" };
  }
  if (paths.has("requirements") || paths.has("responsibilities")) {
    return { material: true, change_kind: "content" };
  }
  if (paths.has("description_text")) {
    const d = diffs.find((x) => x.path === "description_text");
    const before = d?.before || "";
    const after = d?.after || "";
    if (isFormattingOnlyTextChange(before, after)) {
      return { material: false, change_kind: "noise_rebase" };
    }
    const a = stripMarkupForCompare(before);
    const b = stripMarkupForCompare(after);
    const ratio =
      Math.abs(a.length - b.length) / Math.max(a.length, b.length, 1);
    if (ratio < 0.03 && levenshteinish(a, b) < 40) {
      return { material: false, change_kind: "noise_rebase" };
    }
    return { material: true, change_kind: "content" };
  }

  const anyMaterial = diffs.some((d) => MATERIAL_PATHS.has(d.path));
  return {
    material: anyMaterial,
    change_kind: anyMaterial ? "content" : "noise_rebase",
  };
}

function levenshteinish(a: string, b: string): number {
  const n = Math.min(a.length, b.length, 2000);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

export function summarizeDiffs(diffs: FieldDiff[]): string {
  if (!diffs.length) return "no field changes";
  return diffs
    .map((d) => {
      if (d.path === "description_text") {
        if (isFormattingOnlyTextChange(d.before, d.after)) {
          return "description_text: formatting only";
        }
        const b = d.before ? truncate(stripMarkupForCompare(d.before), 40) : "∅";
        const a = d.after ? truncate(stripMarkupForCompare(d.after), 40) : "∅";
        return `description_text: ${b} → ${a}`;
      }
      const b = d.before ? truncate(d.before, 40) : "∅";
      const a = d.after ? truncate(d.after, 40) : "∅";
      return `${d.path}: ${b} → ${a}`;
    })
    .join("; ");
}

/** Drop pure-formatting description diffs; re-summarize remaining. */
export function filterFormattingDiffs(diffs: FieldDiff[]): FieldDiff[] {
  return diffs.filter(
    (d) =>
      d.path !== "description_text" ||
      !isFormattingOnlyTextChange(d.before, d.after),
  );
}

/** Revision row shape for clean-rev compare (F-29 / UX-8). */
export type RevPick = {
  revision: number;
  material?: boolean | null;
  changeKind?: string | null;
};

/** True if revision is useful for default compare (not pure noise/formatting). */
export function isCleanRevision(r: RevPick): boolean {
  if (r.material === true) return true;
  if (r.material === false) return false;
  const kind = (r.changeKind || "").toLowerCase();
  if (
    kind === "noise_rebase" ||
    kind === "noise" ||
    kind === "formatting" ||
    kind === "format_only"
  ) {
    return false;
  }
  return true;
}

/**
 * Default Changes tab pair: latest clean rev vs prior clean rev.
 * Falls back to oldest→newest when fewer than two clean revs.
 */
export function defaultCleanRevCompare(
  revs: RevPick[],
): { from: number; to: number; mode: "clean" | "fallback" } | null {
  if (!revs.length || revs.length < 2) return null;
  const sorted = [...revs].sort((a, b) => a.revision - b.revision);
  const clean = sorted.filter(isCleanRevision);
  if (clean.length >= 2) {
    return {
      from: clean[clean.length - 2]!.revision,
      to: clean[clean.length - 1]!.revision,
      mode: "clean",
    };
  }
  if (clean.length === 1) {
    const c = clean[0]!;
    const prior = [...sorted].reverse().find((r) => r.revision < c.revision);
    if (prior) return { from: prior.revision, to: c.revision, mode: "fallback" };
    const next = sorted.find((r) => r.revision > c.revision);
    if (next) return { from: c.revision, to: next.revision, mode: "fallback" };
  }
  return {
    from: sorted[0]!.revision,
    to: sorted[sorted.length - 1]!.revision,
    mode: "fallback",
  };
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
