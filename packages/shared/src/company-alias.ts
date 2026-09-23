/** Known company slug aliases → canonical slug (prevent dual entities). */
export const COMPANY_SLUG_ALIASES: Record<string, string> = {
  "wellhub-gympass": "wellhub",
  "wellhub-gym-pass": "wellhub",
  gympass: "wellhub",
  "gym-pass": "wellhub",
};

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
  if (COMPANY_SLUG_ALIASES[raw]) return COMPANY_SLUG_ALIASES[raw];
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
