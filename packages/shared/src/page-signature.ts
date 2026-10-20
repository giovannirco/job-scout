/**
 * Signatures of pages that are NOT a job description: ATS vendor marketing
 * boilerplate, soft-404 / closed-listing pages, and loading placeholders.
 * A fetch whose title or JD carries one must never overwrite a position.
 */

export type PageSignature = "vendor_boilerplate" | "not_found" | "placeholder" | "js_wall";

/** "Enable JavaScript" walls (InHire serves "This website need Javascript to run…"). */
const JS_WALL_RE =
  /(this\s+(web)?site\s+needs?\s+javascript|you\s+need\s+to\s+enable\s+javascript|please\s+enable\s+javascript|javascript\s+(is\s+)?(required|disabled)|enable\s+javascript\s+to\s+(run|use|view)|requires\s+javascript|habilite\s+o\s+javascript|precisa\s+(de\s+)?javascript)/i;

/** True for a short page whose text is a JavaScript wall. */
export function isJsWallText(text?: string | null): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return Boolean(t) && t.length < 1500 && JS_WALL_RE.test(t);
}

const VENDOR_RE =
  /(the\s+customizable\s+hiring\s+software|hire\s+smarter\s+and\s+faster|powered\s+by\s+recruitee|recruitee\s+is\s+(a|an|the)\b|acelere\s+seu\s+processo\s+de\s+recrutamento|applicant\s+tracking\s+system\s+(for|that)\b|start\s+(your\s+)?free\s+trial|book\s+a\s+demo|request\s+a\s+demo)/i;

const NOT_FOUND_TITLE_RE =
  /^(?:\W*)(job|position|posting|vacancy|vaga|page|offer|role)?\s*(not\s+found|no\s+longer\s+(available|exists|accepting)|has\s+(been\s+)?(closed|filled|expired)|does\s+not\s+exist|n[aã]o\s+encontrad[ao]|404|expired|unavailable)\b/i;
const NOT_FOUND_BODY_RE =
  /(job\s+not\s+found|this\s+(job|position|posting|role)\s+(is\s+)?no\s+longer\s+(available|open|accepting)|the\s+(job|page)\s+you\s+(are|were)\s+looking\s+for\s+(does\s+not|doesn['’]t)\s+exist|(job|position)\s+has\s+been\s+(closed|filled)|vaga\s+(encerrada|n[aã]o\s+encontrada))/i;

const PLACEHOLDER_RE = /^[\s\W]*(?:(?:inhire|recruitee|loading|carregando)[\s•·.…|\-–—]*)*$/i;

/** Signature in a fetched title. */
export function titleSignature(title?: string | null): PageSignature | null {
  const t = (title || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (isJsWallText(t)) return "js_wall";
  if (NOT_FOUND_TITLE_RE.test(t)) return "not_found";
  if (t.length < 120 && (NOT_FOUND_BODY_RE.test(t) || /\b(is\s+)?no\s+longer\s+(available|open|accepting)\b|\bnot\s+found\b/i.test(t))) return "not_found";
  if (VENDOR_RE.test(t)) return "vendor_boilerplate";
  if (PLACEHOLDER_RE.test(t)) return "placeholder";
  return null;
}

/** Signature in a fetched JD body (short bodies only for not-found / placeholder). */
export function bodySignature(text?: string | null): PageSignature | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (isJsWallText(t)) return "js_wall";
  if (PLACEHOLDER_RE.test(t)) return "placeholder";
  if (t.length < 2000 && NOT_FOUND_BODY_RE.test(t)) return "not_found";
  const vendorHits = (t.match(new RegExp(VENDOR_RE.source, "gi")) || []).length;
  if (vendorHits >= 2 || (vendorHits >= 1 && t.length < 1500)) return "vendor_boilerplate";
  return null;
}

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !["and", "the", "of", "for", "sr", "senior", "staff", "remote"].includes(w)),
  );
}

/** Jaccard similarity of title tokens (0..1). */
export function titleSimilarity(a?: string | null, b?: string | null): number {
  const x = tokens(a || "");
  const y = tokens(b || "");
  if (!x.size || !y.size) return x.size === y.size ? 1 : 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export type SnapshotPageVerdict = { refuse: false } | { refuse: true; signature: PageSignature; where: "title" | "body" };

/**
 * Generic guard: refuse a snapshot when the title or body carries a
 * not-a-JD signature, or when the title changes a lot AND the body looks like
 * vendor boilerplate / not-found.
 */
export function snapshotPageVerdict(prevTitle: string | null | undefined, job: { title?: string | null; descriptionText?: string | null }): SnapshotPageVerdict {
  const ts = titleSignature(job.title);
  if (ts) return { refuse: true, signature: ts, where: "title" };
  const bs = bodySignature(job.descriptionText);
  if (bs === "placeholder" || bs === "not_found" || bs === "js_wall") return { refuse: true, signature: bs, where: "body" };
  if (bs && titleSimilarity(prevTitle, job.title) < 0.34) return { refuse: true, signature: bs, where: "body" };
  return { refuse: false };
}
