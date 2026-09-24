import type { SalaryParse } from "./types.js";

/**
 * Parse common posted salary strings. Returns nulls when unknown — never invents.
 * Examples: $129–304k, BRL 422.5–485k, $4–5k/mo, USD 200000-250000, $200,000 – $250,000
 */
function decodeSalaryEntities(text: string): string {
  return text
    .replace(/&mdash;|&#8212;/gi, "—")
    .replace(/&ndash;|&#8211;/gi, "–")
    .replace(/&euro;/gi, "€")
    .replace(/&pound;/gi, "£");
}

function moneyNumber(raw: string): number | null {
  const s = raw.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return null;
}

/** Drop a trailing thousands group that was glued on from the next sentence. */
function plausibleAmount(token: string): number | null {
  let s = token.trim();
  let n = moneyNumber(s);
  while (n != null && n > 2_000_000 && /[.,]\d{3}$/.test(s)) {
    s = s.replace(/[.,]\d{3}$/, "");
    n = moneyNumber(s);
  }
  return n;
}

/** A posted range, or nothing. Ignores a lone stipend such as "USD$500 home office". */
export function extractSalaryRaw(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const src = decodeSalaryEntities(text);
  const amount = String.raw`\d{1,3}(?:[.,]\d{3})+(?:\.\d+)?|\d{2,}(?:\.\d+)?`;
  const re = new RegExp(String.raw`(?:(USD|EUR|GBP|CAD|£|€|\$)\s*)?(${amount})(?:\s*[kK])?\s*(?:[—–\-]|to)\s*(?:(USD|EUR|GBP|CAD|£|€|\$)\s*)?(${amount})(?:\s*[kK])?`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let min = plausibleAmount(m[2]);
    let max = plausibleAmount(m[4]);
    if (min == null || max == null) continue;
    if (/k/i.test(m[0]) && max < 10000) {
      min *= 1000;
      max *= 1000;
    }
    const tail = src.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const unit = tail.match(/^\s*(?:(?:USD|EUR|GBP|CAD)\s*)?(\/\s*(?:hr|hour|mo|month|yr|year)\b|per\s+(?:hour|month|year|day|week)\b|hourly|monthly|annually)/i)?.[1];
    if (min <= 0 || (!unit && min < 20000) || max < min || max > 2_000_000) continue;
    const window = src.slice(m.index, m.index + m[0].length + 12);
    const mark = `${m[1] || ""} ${m[3] || ""} ${window}`;
    if (!/USD|EUR|GBP|CAD|£|€|\$/.test(mark)) continue;
    const currency = /\bCAD\b|C\$/i.test(mark) ? "CAD"
      : /€|EUR/i.test(mark) ? "EUR"
      : /£|GBP/i.test(mark) ? "GBP"
      : "USD";
    return `${currency} ${Math.round(min)}-${Math.round(max)}${unit ? ` ${unit}` : ""}`;
  }
  return undefined;
}

export function parseSalary(raw: string | null | undefined): SalaryParse {
  if (!raw || !String(raw).trim()) {
    return { min: null, max: null, currency: null, period: null, raw: null };
  }
  const text = String(raw).trim();
  const lower = text.toLowerCase();

  let currency: string | null = null;
  if (/\bbrl\b|r\$/i.test(text)) currency = "BRL";
  else if (/\bcad\b|c\$/i.test(text)) currency = "CAD";
  else if (/\$|usd|us\$/i.test(text)) currency = "USD";
  else if (/\beur\b|€/i.test(text)) currency = "EUR";
  else if (/\bgbp\b|£/i.test(text)) currency = "GBP";

  let period: SalaryParse["period"] = "year";
  if (/\/\s*mo|per\s*month|monthly|\/mo\b/i.test(lower)) period = "month";
  else if (/\/\s*(?:hr|hour)\b|per\s*hour|hourly/i.test(lower)) period = "hour";
  else if (/per\s*(?:day|week)|\/\s*(?:day|week)\b/i.test(lower)) period = null;

  // Strip thousands separators for numeric parse, keep original as raw
  const normalized = text.replace(/,/g, "");

  // $129–304k / $129k-$304k / 129-304k / $200000 – $250000
  const kRange = normalized.match(
    /(?:(?:USD|BRL|EUR|GBP|CAD|US\$|R\$|C\$|£|€|\$)\s*)?(\d+(?:\.\d+)?)\s*[kK]?\s*[-–—to]+\s*(?:(?:USD|BRL|EUR|GBP|CAD|US\$|R\$|C\$|£|€|\$)\s*)?(\d+(?:\.\d+)?)\s*[kK]?/,
  );
  if (kRange) {
    let min = parseFloat(kRange[1]);
    let max = parseFloat(kRange[2]);
    const hasK = /\d\s*[kK]\b/.test(kRange[0]);
    if (hasK && max < 10000) {
      min *= 1000;
      max *= 1000;
    }
    if (!currency) currency = "USD";
    return {
      min: Math.round(min),
      max: Math.round(max),
      currency,
      period,
      raw: text,
    };
  }

  // single value $200k or 200000
  const single = normalized.match(
    /(?:(?:USD|BRL|EUR|GBP|CAD|US\$|R\$|C\$|£|€|\$)\s*)?(\d+(?:\.\d+)?)\s*([kK])?/,
  );
  if (single) {
    let v = parseFloat(single[1]);
    if (single[2]) v *= 1000;
    if (!currency) currency = "USD";
    return {
      min: Math.round(v),
      max: Math.round(v),
      currency,
      period,
      raw: text,
    };
  }

  return { min: null, max: null, currency, period, raw: text };
}

export type SalaryPeriodGuard = {
  period: "year" | "month" | "hour" | "unknown";
  periodLabel: string;
  yearlyMin: number | null;
  yearlyMax: number | null;
  warnMonthly: boolean;
  warnLooksMonthly: boolean;
};

/** Flag monthly/hourly vs yearly so $4–5k/mo is never treated as annual cash. Never invents hours. */
export function salaryPeriodGuard(opts: {
  min?: number | null;
  max?: number | null;
  period?: string | null;
  raw?: string | null;
}): SalaryPeriodGuard {
  const raw = (opts.raw || "").toLowerCase();
  let period: SalaryPeriodGuard["period"] = "unknown";
  if (opts.period === "month" || /\/\s*mo|per\s*month|monthly/.test(raw)) period = "month";
  else if (opts.period === "hour" || /\/\s*hr|hourly|per\s*hour/.test(raw)) period = "hour";
  else if (opts.period === "year" || /\/\s*yr|annual|per\s*year|yearly/.test(raw)) period = "year";
  else if (opts.period) period = "year";

  const min = opts.min ?? null;
  const max = opts.max ?? null;
  const peak = max ?? min;
  const warnLooksMonthly =
    period !== "month" &&
    period !== "hour" &&
    peak != null &&
    peak >= 800 &&
    peak <= 20000 &&
    !/[kK]/.test(opts.raw || "");

  if (period === "month") {
    return {
      period,
      periodLabel: "/mo",
      yearlyMin: min != null ? min * 12 : null,
      yearlyMax: max != null ? max * 12 : null,
      warnMonthly: true,
      warnLooksMonthly: false,
    };
  }
  if (period === "hour") {
    return {
      period,
      periodLabel: "/hr",
      yearlyMin: null,
      yearlyMax: null,
      warnMonthly: false,
      warnLooksMonthly: false,
    };
  }
  return {
    period: period === "year" ? "year" : "unknown",
    periodLabel: period === "year" ? "/yr" : "",
    yearlyMin: min,
    yearlyMax: max,
    warnMonthly: false,
    warnLooksMonthly,
  };
}
