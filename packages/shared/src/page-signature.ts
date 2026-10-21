/**
 * Signatures of pages that are NOT a job description: ATS vendor marketing
 * boilerplate, soft-404 / closed-listing pages, and loading placeholders.
 * A fetch whose title or JD carries one must never overwrite a position.
 */

export type PageSignature = "vendor_boilerplate" | "not_found" | "placeholder" | "js_wall";

/**
 * "Enable JavaScript" walls (InHire serves "This website need Javascript…").
 * Only wall phrasing counts: a JD that "requires JavaScript, TypeScript" is a JD.
 */
const JS_WALL_RE =
  /(this\s+(?:web\s*)?(?:site|page|app(?:lication)?)\s+(?:needs?|requires?)\s+javascript|(?:you\s+need\s+to|please|kindly)\s+(?:enable|turn\s+on|activate)\s+javascript|(?:enable|turn\s+on)\s+javascript\s+(?:to|in\s+your\s+browser)|javascript\s+is\s+(?:disabled|turned\s+off|not\s+enabled)|javascript\s+(?:is\s+)?required\s+to\s+(?:run|use|view|display|load)|(?:no|without)\s+javascript\s+support|habilite\s+o\s+javascript|ative\s+o\s+javascript|(?:este\s+site|esta\s+p[aá]gina|o\s+site|a\s+p[aá]gina)\s+precisa\s+(?:de\s+|do\s+)?javascript)/iu;

/** Characters that are not letters or digits in any script. */
const NON_WORD = String.raw`[\s\p{P}\p{S}]`;

/** True for a short page whose text is a JavaScript wall and little else. */
export function isJsWallText(text?: string | null): boolean {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || t.length >= 1500) return false;
  if (!JS_WALL_RE.test(t)) return false;
  // Whatever is left once the wall phrases are removed must be near-empty.
  const rest = t.replace(new RegExp(JS_WALL_RE.source, "giu"), " ").replace(new RegExp(`${NON_WORD}+`, "gu"), " ").trim();
  return rest.length < 200;
}

const VENDOR_RE =
  /(the\s+customizable\s+hiring\s+software|hire\s+smarter\s+and\s+faster|powered\s+by\s+recruitee|recruitee\s+is\s+(a|an|the)\b|acelere\s+seu\s+processo\s+de\s+recrutamento|applicant\s+tracking\s+system\s+(for|that)\b|start\s+(your\s+)?free\s+trial|book\s+a\s+demo|request\s+a\s+demo)/i;

const SUBJECT = String.raw`(?:job|position|posting|vacancy|opening|page|offer|role|listing)`;
/**
 * Error-page titles. Each pattern must match a WHOLE title segment
 * ("Job Not Found", "Acme Careers | Page not found"), never a substring of a
 * real title ("Not Found Engineer", "404 Labs — Backend Engineer").
 */
const NOT_FOUND_TITLE_SEGMENTS: RegExp[] = [
  /^(?:(?:error|erro)\s*)?404(?:\s*(?:error|erro|not\s+found|page\s+not\s+found))?$/iu,
  new RegExp(String.raw`^(?:(?:sorry|oops)${NON_WORD}*)?(?:(?:the|this)\s+)?(?:${SUBJECT}\s+)?(?:(?:is|was)\s+)?(?:not\s+found|no\s+longer\s+(?:available|exists|open|active|accepting\s+applications)|does\s+not\s+exist|doesn['’]t\s+exist|(?:could|can)\s*not\s+be\s+found|unavailable|expired)$`, "iu"),
  new RegExp(String.raw`^(?:(?:the|this)\s+)?${SUBJECT}\s+(?:has\s+)?(?:been\s+)?(?:closed|filled|expired|removed)$`, "iu"),
  /^(?:(?:esta|a)\s+)?(?:vaga|p[aá]gina)\s+(?:n[aã]o\s+(?:foi\s+)?encontrad[ao]|n[aã]o\s+existe|(?:foi\s+)?encerrad[ao]|expirad[ao]|indispon[ií]vel)$/iu,
  /^n[aã]o\s+encontrad[ao]$/iu,
];
const TITLE_SEPARATOR_RE = /\s+[|\-–—·•:]\s+|\s*[|–—•]\s*/u;
const EDGE_NON_WORD_RE = new RegExp(`^${NON_WORD}+|${NON_WORD}+$`, "gu");

function isNotFoundTitle(t: string): boolean {
  if (t.length > 160) return false;
  return [t, ...t.split(TITLE_SEPARATOR_RE)]
    .map((seg) => seg.replace(EDGE_NON_WORD_RE, "").replace(/\s+/g, " ").trim())
    .some((seg) => seg.length > 0 && NOT_FOUND_TITLE_SEGMENTS.some((re) => re.test(seg)));
}

/** Soft-404 phrasing in a page body: subject-anchored, never bare "has been filled". */
/** Sentence start (optionally "Sorry," / "Unfortunately,"): "Once the position has been filled" is a JD. */
const SENTENCE_START = String.raw`(?:^|[.!?:]\s*)(?:(?:sorry|unfortunately|oops)[\s,!.]*)?`;
const NOT_FOUND_BODY_RE = new RegExp(
  String.raw`(\bjob\s+not\s+found\b|\bpage\s+not\s+found\b|${SENTENCE_START}(?:this|the)\s+(?:job|position|posting|role|vacancy|opening)\s+(?:is\s+)?no\s+longer\s+(?:available|open|active|accepting(?:\s+applications)?)|the\s+(?:job|page|position)\s+you\s+(?:are|were)\s+looking\s+for\s+(?:does\s+not|doesn['’]t)\s+exist|${SENTENCE_START}(?:this|the)\s+(?:job|position|posting|vacancy)\s+has\s+been\s+(?:closed|filled|removed)|${SENTENCE_START}esta\s+vaga\s+(?:foi\s+)?(?:encerrada|n[aã]o\s+est[aá]\s+(?:mais\s+)?dispon[ií]vel)|vaga\s+n[aã]o\s+encontrada)`,
  "iu",
);
/** Section markers of a real JD; a long body carrying them is not an error page. */
const JD_MARKER_RE =
  /(responsibilities|requirements|qualifications|what\s+you['’]?ll\s+do|what\s+we['’]?re\s+looking\s+for|about\s+the\s+role|nice\s+to\s+have|benefits|requisitos|responsabilidades|atribui[cç][oõ]es|diferenciais|benef[ií]cios)/i;

/** Only punctuation, symbols, whitespace and ATS/loading words — in any script. */
const PLACEHOLDER_RE = new RegExp(String.raw`^${NON_WORD}*(?:(?:inhire|recruitee|loading|carregando)${NON_WORD}*)*$`, "iu");

/** Signature in a fetched title. */
export function titleSignature(title?: string | null): PageSignature | null {
  const t = (title || "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (isJsWallText(t)) return "js_wall";
  if (isNotFoundTitle(t)) return "not_found";
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
  if (t.length < 2000 && NOT_FOUND_BODY_RE.test(t) && !(t.length >= 600 && JD_MARKER_RE.test(t))) return "not_found";
  const vendorHits = (t.match(new RegExp(VENDOR_RE.source, "gi")) || []).length;
  if (vendorHits >= 2 || (vendorHits >= 1 && t.length < 1500)) return "vendor_boilerplate";
  return null;
}

/**
 * A body-only soft-404 is believable when the incoming page is much shorter
 * than the JD on file: an error page is short, a JD that merely mentions
 * "this position has been filled" keeps its length.
 */
export function bodyNotFoundPlausible(prevBody: string | null | undefined, incomingBody: string | null | undefined): boolean {
  const prev = (prevBody || "").replace(/\s+/g, " ").trim().length;
  const next = (incomingBody || "").replace(/\s+/g, " ").trim().length;
  if (!prev) return true;
  return next < 600 && next < prev * 0.4;
}

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !["and", "the", "of", "for", "sr", "senior", "staff", "remote"].includes(w)),
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
 * vendor boilerplate / not-found. With `prevBody` (the JD on file), a body-only
 * soft-404 counts only when the incoming page is much shorter than that JD.
 */
export function snapshotPageVerdict(
  prevTitle: string | null | undefined,
  job: { title?: string | null; descriptionText?: string | null },
  opts: { prevBody?: string | null } = {},
): SnapshotPageVerdict {
  const ts = titleSignature(job.title);
  if (ts) return { refuse: true, signature: ts, where: "title" };
  const bs = bodySignature(job.descriptionText);
  if (bs === "not_found" && !bodyNotFoundPlausible(opts.prevBody, job.descriptionText)) return { refuse: false };
  if (bs === "placeholder" || bs === "not_found" || bs === "js_wall") return { refuse: true, signature: bs, where: "body" };
  if (bs && titleSimilarity(prevTitle, job.title) < 0.34) return { refuse: true, signature: bs, where: "body" };
  return { refuse: false };
}
