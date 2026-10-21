/** Known company slug aliases → canonical slug (prevent dual entities). */
export const COMPANY_SLUG_ALIASES: ReadonlyMap<string, string> = new Map([
  ["wellhub-gympass", "wellhub"],
  ["wellhub-gym-pass", "wellhub"],
  ["gympass", "wellhub"],
  ["gym-pass", "wellhub"],
]);

/** Keys that resolve on a plain object through Object.prototype (lowercased). */
export const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(
  [...Object.getOwnPropertyNames(Object.prototype), "__proto__", "prototype"].map((k) => k.toLowerCase()),
);

/** A slug that came from stringifying a function (e.g. "function Object() { [native code] }"). */
export function isPrototypeSlug(slug?: string | null): boolean {
  const s = String(slug || "").toLowerCase();
  if (!s) return false;
  return /native[\s-]*code|[{}()]/.test(s);
}

export function normalizeCompanyKey(input: string): string {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Resolve a free-text company name or slug to the canonical company slug. */
export function canonicalCompanySlug(nameOrSlug: string): string {
  const raw = normalizeCompanyKey(nameOrSlug);
  if (!raw) return raw;
  const alias = COMPANY_SLUG_ALIASES.get(raw);
  if (alias) return alias;
  if (raw.includes("wellhub") && raw.includes("gympass")) return "wellhub";
  if (raw === "gympass" || raw.startsWith("gympass-")) return "wellhub";
  return raw;
}

/** Preferred display name when collapsing known aliases. */
export function preferredCompanyName(nameOrSlug: string, fallbackName?: string): string {
  const canon = canonicalCompanySlug(nameOrSlug);
  if (canon === "wellhub") return "Wellhub";
  return fallbackName || nameOrSlug;
}
