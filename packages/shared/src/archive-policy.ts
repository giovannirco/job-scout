import { parseSalary, salaryPeriodGuard } from "./salary.js";

/**
 * Auto-archive policy. A triage verdict may archive a position only for a hard
 * disqualifier the candidate cannot change:
 *   - residency / location eligibility
 *   - work authorization (citizenship, visa, clearance)
 *   - onsite or hybrid workplace
 *   - posted pay under the profile's cash floor
 * Skill gaps, low scores and soft flags keep the position active with its score.
 */
export type HardDisqualifierKind = "work_authorization" | "workplace" | "pay" | "residency";

const RULES: Array<[HardDisqualifierKind, RegExp]> = [
  ["work_authorization", /\b(citizen(ship)?s?|green\s*card|(work(ing)?|employment)\s+authori[sz]ation|authori[sz]ed\s+to\s+work|right\s+to\s+work|work\s+permit|visa|sponsor(ship)?|security\s+clearance|clearance|itar|permanent\s+resident|eligib(le|ility)\s+to\s+work)\b/i],
  ["workplace", /\b(on-?\s?site|in-?\s?office|in\s+the\s+office|office[-\s](based|hire)|hybrid|relocat(e|ion)|commut(e|ing)|no\s+remote(\s+\w+)?\s+(path|option))\b/i],
  ["pay", /\b(salary|compensation|comp|pay|paid|wage|cash|floor|under\s+ask)\b/i],
  ["residency", new RegExp([
    "\\b(resid(e|ent|ents|ency|ing)|must\\s+(live|be\\s+based|be\\s+located)|based\\s+in|located\\s+in|living\\s+in)\\b",
    "\\b(contractor|eor)\\b[^.;]{0,40}\\bpath\\b",
    "\\b[A-Za-z]{2,}-only\\s+(remote|fte|full-time|employment|role|hire|position)\\b",
    "\\bremote[\\s,-]+[A-Za-z]{2,}-only\\b",
    "\\b(states|kingdom|us|usa|uk|eu|emea|apac|latam|americas|europe|canada)\\s+only\\b",
    "\\bcandidates\\s+only\\b",
    "\\b(restricted|limited)\\s+to\\b",
    "\\bcandidate\\s+is\\s+(in|based|located)\\b",
    "\\b(not\\s+(hiring|eligible)\\s+in|outside\\s+(the\\s+)?(allowed|eligible|hiring))\\b",
    "\\b(countr(y|ies)|geo(graphic)?\\s*(restriction|block|lock)|location\\s+(restriction|requirement|eligibility|mismatch))\\b",
  ].join("|"), "i")],
];

/** Every hard-disqualifier kind a phrase names, in priority order. Empty = skill gap, fit or score only. */
export function hardDisqualifierKinds(text: string | null | undefined): HardDisqualifierKind[] {
  const t = (text || "").trim();
  if (!t) return [];
  // Timezone overlap alone is not residency.
  const withoutTz = t.replace(/\b(time\s*zones?|timezones?|[A-Z]{2,4}\s+hours|overlap)\b/gi, " ");
  return RULES.filter(([, re]) => re.test(withoutTz)).map(([kind]) => kind);
}

/** Classify one hard-disqualifier or archive-reason phrase. null = not a hard disqualifier (skill gap, fit, score). */
export function hardDisqualifierKind(text: string | null | undefined): HardDisqualifierKind | null {
  return hardDisqualifierKinds(text)[0] ?? null;
}

/** Posted pay as a yearly USD maximum, or null when unknown or not USD. */
export function postedYearlyUsdMax(salaryRaw: string | null | undefined): number | null {
  const s = parseSalary(salaryRaw);
  if (s.currency !== "USD" || (s.max ?? s.min) == null) return null;
  const g = salaryPeriodGuard({ min: s.min, max: s.max, period: s.period, raw: s.raw });
  if (g.period === "hour" || g.warnLooksMonthly) return null;
  return g.yearlyMax ?? g.yearlyMin;
}

export type ArchiveDecision =
  | { archive: true; kind: HardDisqualifierKind; reason: string }
  | { archive: false; why: "no_hard_disqualifier" | "pay_not_posted" | "pay_at_or_above_floor" };

/**
 * Decide whether a triage FAIL may archive. `hardDq` is the model's list; pay
 * only counts when pay is posted, and a parseable USD yearly max at or above
 * `payFloorUsd` overrides the model.
 */
export function triageArchiveDecision(input: { hardDq: readonly string[]; salaryRaw?: string | null; payFloorUsd?: number | null }): ArchiveDecision {
  let payWhy: ArchiveDecision | null = null;
  for (const dq of input.hardDq) {
    for (const kind of hardDisqualifierKinds(dq)) {
      if (kind === "pay") {
        if (!input.salaryRaw?.trim()) { payWhy ??= { archive: false, why: "pay_not_posted" }; continue; }
        const max = postedYearlyUsdMax(input.salaryRaw);
        if (max != null && input.payFloorUsd && input.payFloorUsd > 0 && max >= input.payFloorUsd) { payWhy ??= { archive: false, why: "pay_at_or_above_floor" }; continue; }
      }
      return { archive: true, kind, reason: dq };
    }
  }
  return payWhy ?? { archive: false, why: "no_hard_disqualifier" };
}

/** Actors that are the app itself (not a person or an operator agent). */
export const AUTOMATED_ACTOR = /^(system|autopilot|career-ops|intake|scan(?::.*)?|triage|evaluate|import|seed|repair)$/;
