import { postedYearlyUsdMax, hardDisqualifierKinds } from "./archive-policy.js";
import { ATS_KEYWORD_CATALOG, termInText } from "./ats-keywords.js";
import { geoClass, workplaceOf } from "./classify.js";
import type { GeoClass, Workplace } from "./types.js";

/**
 * Recruiter leads: a recruiter pitching a role with no job URL, pay band or
 * named client yet. Pure helpers: dedupe keys, redaction and a deterministic
 * triage that never calls a model and never invents a USD figure.
 */
export const LEAD_STATUSES = ["new", "vetted", "replied", "screening_scheduled", "screened", "promoted", "closed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_TERMINAL_STATUSES: readonly LeadStatus[] = ["promoted", "closed"];

export const LEAD_DIRECTIONS = ["inbound", "outbound", "note"] as const;
export type LeadDirection = (typeof LEAD_DIRECTIONS)[number];

/** Work-queue buckets for active leads, in priority order. */
export const LEAD_BUCKETS = ["call_soon", "needs_reply", "waiting", "stalled"] as const;
export type LeadBucket = (typeof LEAD_BUCKETS)[number];

/** A lead with no activity for this long is stalled; an outbound message younger than this is waiting. */
export const LEAD_STALL_DAYS = 7;
/** A pending screening inside this window (hours ahead) puts the lead in call_soon. */
export const LEAD_CALL_SOON_HOURS = 72;

export function parseLeadStatus(v: string): LeadStatus {
  const s = v.trim().toLowerCase();
  if (!(LEAD_STATUSES as readonly string[]).includes(s)) throw new Error(`status must be ${LEAD_STATUSES.join("|")}`);
  return s as LeadStatus;
}

export function parseLeadDirection(v: string | null | undefined): LeadDirection {
  const s = (v || "").trim().toLowerCase();
  if (!(LEAD_DIRECTIONS as readonly string[]).includes(s)) throw new Error(`direction must be ${LEAD_DIRECTIONS.join("|")}`);
  return s as LeadDirection;
}

/** Profile URL reduced to host + path: lowercase, no scheme, www, query, fragment or trailing slash. */
export function normalizeProfileUrl(url: string | null | undefined): string | null {
  const raw = (url || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase().replace(/^(www|m|[a-z]{2})\.(?=linkedin\.com$)/, "").replace(/^www\./, "");
    const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "");
    return `${host}${path}` || null;
  } catch {
    return raw.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "") || null;
  }
}

const norm = (s: string | null | undefined) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+#]+/g, " ").trim();

/**
 * One lead per recruiter × pitched role. The recruiter is the profile URL, else
 * the email, else name + firm; null when none is known (no dedupe then).
 */
export function leadDedupeKey(input: { recruiterProfileUrl?: string | null; recruiterEmail?: string | null; recruiterName?: string | null; recruiterCompany?: string | null; pitchedRole?: string | null }): string | null {
  const who = normalizeProfileUrl(input.recruiterProfileUrl)
    || (input.recruiterEmail?.trim() ? `mailto:${input.recruiterEmail.trim().toLowerCase()}` : null)
    || (norm(input.recruiterName) ? `name:${norm(input.recruiterName)}@${norm(input.recruiterCompany)}` : null);
  if (!who) return null;
  return `${who}|${norm(input.pitchedRole)}`;
}

// 10–15 digits with optional +, spaces, dots, dashes or parentheses. Dates (8
// digits), salaries with thousands commas and digits inside URLs/ids are left alone.
const PHONE_RE = /(?<![\w/=#.-])\+?\(?\d(?:[\s().-]{0,2}\d){9,14}(?![\w/])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Numbers shared as links (wa.me/…, ?phone=…, tel:…) sit right after "/" or "=", which PHONE_RE skips.
const PHONE_LINK_RE = /(wa\.me\/|[?&]phone=|tel:)\+?\d[\d().\s-]{6,}\d/gi;

/** Redact phone numbers and email addresses from a message body before it is stored or logged. */
export function redactContactText(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_LINK_RE, "$1[phone]")
    .replace(PHONE_RE, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) ? m : "[phone]"));
}

export type LeadPayCheck =
  | { status: "below_floor" | "at_or_above_floor"; usdYearlyMax: number; floorUsd: number }
  | { status: "not_stated" | "floor_unset" | "not_comparable"; usdYearlyMax: null; floorUsd: number | null };

export type LeadTriage = {
  /** pass: nothing blocks · hold: open questions first · fail: a stated term is under the floor or a hard block */
  verdict: "pass" | "hold" | "fail";
  pay: LeadPayCheck;
  geo: { geoClass: GeoClass; workplace: Workplace; hardBlocks: string[] };
  stack: { matched: string[]; unmatched: string[] };
  unknowns: string[];
  reasons: string[];
};

export type LeadTriageInput = {
  pitchedRole?: string | null;
  clientHint?: string | null;
  statedPay?: string | null;
  statedGeo?: string | null;
  statedContract?: string | null;
  notes?: string | null;
  openUnknowns?: readonly string[] | null;
};

/** Explicit USD: a "$" or "USD" with no other currency marker. Bare "90k" stays unknown. */
function explicitUsd(text: string): boolean {
  if (/\bbrl\b|r\$|\bcad\b|c\$|\beur\b|€|\bgbp\b|£|\bars\b|\bmxn\b|\bcop\b|\bclp\b/i.test(text)) return false;
  return /\$|\busd\b/i.test(text);
}

export function leadPayCheck(statedPay: string | null | undefined, floorUsd: number | null | undefined): LeadPayCheck {
  const pay = (statedPay || "").trim();
  const floor = floorUsd && floorUsd > 0 ? floorUsd : null;
  if (!pay || !/\d/.test(pay)) return { status: "not_stated", usdYearlyMax: null, floorUsd: floor };
  if (!floor) return { status: "floor_unset", usdYearlyMax: null, floorUsd: null };
  const usd = explicitUsd(pay) ? postedYearlyUsdMax(pay) : null;
  if (usd == null) return { status: "not_comparable", usdYearlyMax: null, floorUsd: floor };
  return { status: usd >= floor ? "at_or_above_floor" : "below_floor", usdYearlyMax: usd, floorUsd: floor };
}

/**
 * Deterministic lead triage: cash floor (only a comparable USD yearly figure),
 * geography/remote hints from the stated terms, stack terms the profile claims,
 * and an unknowns gate. Leads are never archived or alerted on from this.
 */
export function leadTriage(input: LeadTriageInput, profile: { cashFloorUsd?: number | null; stackText?: string | null }): LeadTriage {
  const reasons: string[] = [];
  const pay = leadPayCheck(input.statedPay, profile.cashFloorUsd);
  const geoText = [input.statedGeo, input.statedContract].filter(Boolean).join(" | ");
  const geo = geoClass(input.statedGeo || "", "", input.statedContract || "");
  const workplace = workplaceOf(null, null, geoText);
  const hardBlocks = [...new Set(hardDisqualifierKinds(geoText).filter((k) => k !== "pay"))];
  const blob = [input.pitchedRole, input.statedContract, input.notes].filter(Boolean).join("\n");
  const leadTerms = ATS_KEYWORD_CATALOG.filter((t) => termInText(t, blob));
  const stackText = profile.stackText || "";
  const matched = leadTerms.filter((t) => termInText(t, stackText));
  const unmatched = leadTerms.filter((t) => !matched.includes(t));

  const unknowns = [...new Set((input.openUnknowns || []).map((u) => u.trim()).filter(Boolean))];
  const add = (u: string) => { if (!unknowns.includes(u)) unknowns.push(u); };
  if (!input.clientHint?.trim()) add("client");
  if (pay.status === "not_stated") add("pay");
  if (pay.status === "not_comparable") add("pay in USD per year");
  if (!input.statedGeo?.trim()) add("geography");
  if (!input.statedContract?.trim()) add("contract type");

  let verdict: LeadTriage["verdict"] = "pass";
  if (pay.status === "below_floor") {
    verdict = "fail";
    reasons.push(`stated pay ${pay.usdYearlyMax} USD/yr is under the floor ${pay.floorUsd}`);
  }
  if (geo === "hard_geo" || workplace === "onsite" || workplace === "hybrid" || hardBlocks.length) {
    verdict = "fail";
    reasons.push(`geography/workplace: ${[geo, workplace, ...hardBlocks].filter((x) => x !== "unknown").join(", ")}`);
  }
  if (verdict === "pass" && unknowns.length) {
    verdict = "hold";
    reasons.push(`open: ${unknowns.join(", ")}`);
  }
  if (matched.length) reasons.push(`stack: ${matched.join(", ")}`);
  return { verdict, pay, geo: { geoClass: geo, workplace, hardBlocks }, stack: { matched, unmatched }, unknowns, reasons };
}
