/** Display cleanup: trailing ATS junk (`\`, stray spaces). */
export function cleanPositionTitle(title: string): string {
  return String(title || "")
    .replace(/\\+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a job title into a family key for grouping near-duplicate
 * postings at the same company (shells / sibling reqs).
 */
export function roleFamilyKey(title: string): string {
  return cleanPositionTitle(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[|–—\-_/·,]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(
      /\b(junior|jr|mid|senior|sr|staff|principal|lead|head|i{1,3}|iv|v|vi{0,3}|l\d+)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Statuses we refuse to bulk-archive as sibling shells. */
export const SHELL_PROTECTED_STATUSES = new Set([
  "applied",
  "screen",
  "interview",
  "offer",
  "materials",
]);

export function isShellArchiveable(status?: string | null): boolean {
  if (!status) return true;
  return !SHELL_PROTECTED_STATUSES.has(status);
}

export function groupPositionsByRoleFamily<
  T extends { title: string; id?: string; status?: string; fitScore?: number | null },
>(rows: T[]): Array<{ family: string; label: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = roleFamilyKey(row.title) || "other";
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  const statusRank = (s?: string) => {
    const order = [
      "screen",
      "interview",
      "applied",
      "materials",
      "research",
      "idea",
      "offer",
      "rejected",
      "skip",
      "archive",
    ];
    const i = order.indexOf(s || "");
    return i < 0 ? 50 : i;
  };
  return [...map.entries()]
    .map(([family, items]) => {
      const sorted = [...items].sort((a, b) => {
        const sr = statusRank(a.status) - statusRank(b.status);
        if (sr !== 0) return sr;
        return (b.fitScore ?? 0) - (a.fitScore ?? 0);
      });
      return {
        family,
        label: sorted[0]?.title || family,
        items: sorted,
      };
    })
    .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}
