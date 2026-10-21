import { parseSalary, salaryPeriodGuard } from "./salary.js";
import { stripTzPhrases } from "./tz-policy.js";

/**
 * Auto-archive policy. A triage verdict may archive a position only for a hard
 * disqualifier the candidate cannot change:
 *   - residency / location eligibility
 *   - work authorization (citizenship, visa sponsorship, clearance)
 *   - onsite or hybrid workplace
 *   - posted pay, as a comparable USD yearly figure, under the profile's cash floor
 * Skill gaps, low scores and soft flags keep the position active with its score.
 */
export type HardDisqualifierKind = "work_authorization" | "workplace" | "pay" | "residency";

const any = (parts: RegExp[]) => new RegExp(parts.map((r) => r.source).join("|"), "i");

// Every rule anchors on eligibility phrasing, never on a bare topic word. Skill-gap
// lines such as "No Visa/payments domain experience", "multi-country payroll
// experience not claimed", "limited to Terraform" or "hybrid cloud experience not
// claimed" must not read as hard disqualifiers.
const RULES: Array<[HardDisqualifierKind, RegExp]> = [
  ["work_authorization", any([
    /\bcitizen(ship|s)?\b/,
    /\bgreen\s*card\b/,
    /\b(work(ing)?|employment)\s+authori[sz]ation\b/,
    /\bauthori[sz]ed\s+to\s+work\b/,
    /\bright\s+to\s+work\b/,
    /\bwork\s+(permit|visa)s?\b/,
    /\bvisa\s+sponsor(ship|ed)?\b/,
    /\b(no|not|without|cannot|can't|won't|doesn't|does\s+not|unable\s+to)\s+(offer\s+|provide\s+)?(visa\s+)?sponsor(ship)?\b/,
    /\bsponsorship\s+(is\s+)?(not\s+)?(available|offered|provided|required|needed)\b/,
    /\brequires?\s+(a\s+)?(work\s+)?visa\b/,
    /\b(security|secret|top\s+secret|ts\s*\/\s*sci|government|dod|public\s+trust)\s+clearance\b/,
    /\bclearance\s+(is\s+)?(required|needed|mandatory)\b/,
    /\bitar\b/,
    /\bpermanent\s+residen(t|cy)\b/,
    /\beligib(le|ility)\s+to\s+work\b/,
  ])],
  ["workplace", any([
    /\bon-?\s?site\b/,
    /\bin-?\s?office\b/,
    /\bin\s+the\s+office\b/,
    /\boffice[-\s](based|hire)\b/,
    // "hybrid" as a work arrangement, not hybrid cloud/infrastructure/networking.
    /\bhybrid\b(?![-\s]*(cloud|infra(structure)?|environments?|deployments?|architectures?|connectivity|network(ing)?|mesh|search|apps?|systems?|workloads?|kubernetes|k8s|mobile|setups?))/,
    /\b\d\s*\+?\s*days?\s+(a|per)\s+week\s+(in|on)[-\s]?(the\s+)?(office|site)\b/,
    /\brelocation\s+(is\s+)?(required|mandatory|needed|expected)\b/,
    /\b(must|required\s+to|need\s+to|expected\s+to)\s+(be\s+willing\s+to\s+)?relocate\b/,
    /\brequires?\s+relocation\b/,
    /\bcommut(able|ing)\s+distance\b/,
    /\b(must|able\s+to|required\s+to)\s+commute\b/,
    /\bno\s+remote(\s+\w+)?\s+(path|option)\b/,
  ])],
  // Pay is named only as "pay below/under <floor, ask, a figure>"; whether it
  // archives is then decided numerically by triageArchiveDecision.
  ["pay", any([
    /\b(salary|compensation|comp|pay|paid|wage|cash)\b[^.;]{0,40}\b(below|under|less\s+than|lower\s+than|short\s+of|beneath)\b[^.;]{0,30}(\b(floor|ask|minimum|threshold|target|expectations?|last|current|cash|requirement)\b|[$€£]|\d)/,
    /\b(below|under|beneath)\s+(the\s+)?(profile\s+|candidate'?s?\s+)?(cash\s+|pay\s+|salary\s+)?(floor|ask)\b/,
  ])],
  ["residency", any([
    /\bmust\s+(reside|live|be\s+(a\s+)?resident|be\s+based|be\s+located|be\s+living)\b/,
    /\b(required|need|needs)\s+to\s+(reside|live|be\s+based|be\s+located)\b/,
    /\bresid(e|es|ing|ency)\s+(in|within|requirement|required)\b/,
    /\b(residents|citizens|nationals)\s+(of\s+[^.;]{1,30}\s+)?only\b/,
    /\b(candidates|applicants)\s+(must\s+be\s+)?(based|located|living|residing)\s+in\b/,
    /\b(contractor|eor)\b[^.;]{0,40}\b(path|option|route)\b/,
    /\b[A-Za-z]{2,}-only\s+(remote|fte|full-time|employment|hir(e|es|ing))\b/,
    /\bremote[\s,-]+[A-Za-z]{2,}-only\b/,
    /\b(states|kingdom|us|usa|uk|eu|emea|apac|latam|americas|europe|canada)\s+only\b/,
    /\b(candidates|applicants)\s+only\b/,
    /\b(remote|role|position|hiring|employment|work|job|opening)\s+(is\s+)?(restricted|limited)\s+to\b/,
    /\b(restricted|limited)\s+to\s+(candidates|applicants|residents|people|those|employees|persons)\s+(in|from|based|located|living|residing|who)\b/,
    /\b(hiring|hires|employs?)\s+only\s+(in|from)\b/,
    /\bonly\s+(hir(es|ing)|employs?)\s+(in|from)\b/,
    /\bcandidate\s+is\s+(based|located|living)\s+(in|outside)\b/,
    /\b(not\s+(hiring|eligible)\s+in|outside\s+(the\s+)?(allowed|eligible|hiring|approved|supported))\b/,
    /\b(eligible|approved|supported|hiring|permitted)\s+(countr(y|ies)|regions?|locations?|states)\b/,
    /\bineligible\s+(location|countr(y|ies)|region)\b/,
    /\bgeo(graphic)?\s*(restriction|block|lock)\b/,
    /\blocation\s+(restriction|requirement|eligibility|mismatch)\b/,
  ])],
];

/** Every hard-disqualifier kind a phrase names, in priority order. Empty = skill gap, fit or score only. */
export function hardDisqualifierKinds(text: string | null | undefined): HardDisqualifierKind[] {
  const t = (text || "").trim();
  if (!t) return [];
  // Timezone overlap alone is not residency ("US time zones only" is not "US only").
  const withoutTz = stripTzPhrases(t);
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

export type ArchiveNotWhy =
  | "no_hard_disqualifier"
  | "pay_not_posted"
  | "pay_floor_unset"
  | "pay_not_comparable"
  | "pay_at_or_above_floor";

export type ArchiveDecision =
  | { archive: true; kind: HardDisqualifierKind; reason: string }
  | { archive: false; why: ArchiveNotWhy };

/**
 * Decide whether a triage FAIL may archive. `hardDq` is the model's list. A pay
 * disqualifier archives only when the profile sets a cash floor (> 0) and the
 * posted maximum is a comparable USD yearly figure below it; unposted,
 * non-USD, hourly or ambiguous pay never archives.
 */
export function triageArchiveDecision(input: { hardDq: readonly string[]; salaryRaw?: string | null; payFloorUsd?: number | null }): ArchiveDecision {
  let payWhy: ArchiveDecision | null = null;
  const floor = input.payFloorUsd ?? 0;
  for (const dq of input.hardDq) {
    for (const kind of hardDisqualifierKinds(dq)) {
      if (kind === "pay") {
        const why = payNotArchiveWhy(input.salaryRaw, floor);
        if (why) { payWhy ??= { archive: false, why }; continue; }
      }
      return { archive: true, kind, reason: dq };
    }
  }
  return payWhy ?? { archive: false, why: "no_hard_disqualifier" };
}

function payNotArchiveWhy(salaryRaw: string | null | undefined, floor: number): ArchiveNotWhy | null {
  if (!salaryRaw?.trim()) return "pay_not_posted";
  if (!(floor > 0)) return "pay_floor_unset";
  const max = postedYearlyUsdMax(salaryRaw);
  if (max == null) return "pay_not_comparable";
  return max >= floor ? "pay_at_or_above_floor" : null;
}

/**
 * Actors that are the app itself or an automated sync, never a person or an
 * operator agent. Status events by these actors neither restore nor drop a
 * position on a person's behalf. Every automated writer in the codebase:
 *   system      default actor; listing-closed and data-repair archives
 *   autopilot   automated materials/approval runs
 *   career-ops  the career-ops tracker sync (also any `career-ops…` token name)
 *   intake      upsertFromJob revive fallback when no source is given
 *   scan, scan:* board scans and discovery (scan:greenhouse, scan:discovery, …)
 *   triage, evaluate, interview_brief  model operations
 *   watch       JD watcher snapshots
 *   repair      archive-policy repair CLI
 *   import, seed  bootstrap/import tooling
 * Human: operator, signed-in user names, MCP token names, "chat" (the in-app
 * assistant acting on the person's request), "manual" (intake of a URL by a
 * person or agent) and "clip" (the bookmarklet, a person clipping a tab).
 */
export const AUTOMATED_ACTORS = ["system", "autopilot", "career-ops", "intake", "scan", "triage", "evaluate", "interview_brief", "watch", "repair", "import", "seed"] as const;

/** Kept for compatibility: matches the exact automated actor names and `scan:*`. */
export const AUTOMATED_ACTOR = new RegExp(`^(${AUTOMATED_ACTORS.join("|")}|scan:.*)$`);

/** Split MCP caller attribution "<agent> via <token>" into its parts. */
function actorParts(actor: string): { caller: string | null; token: string } {
  const via = actor.lastIndexOf(" via ");
  return via >= 0 ? { caller: actor.slice(0, via).trim(), token: actor.slice(via + 5).trim() } : { caller: null, token: actor };
}

/**
 * A career-ops sync actor: "career-ops", a token named "career-ops…" (e.g.
 * "career-ops-sync"), or a caller naming itself career-ops on any token
 * ("career-ops via <token>").
 */
export const isCareerOpsActor = (actor: string | null | undefined) => {
  const { caller, token } = actorParts(String(actor || "").trim());
  return /^career-ops\b/i.test(token) || (caller != null && /^career-ops\b/i.test(caller));
};

/** True for the app itself or an automated sync; a missing actor is the app ("system"). */
export function isAutomatedActor(actor: string | null | undefined): boolean {
  const a = String(actor || "system").trim();
  return AUTOMATED_ACTOR.test(actorParts(a).token) || isCareerOpsActor(a);
}
