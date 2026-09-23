export type SortDir = "asc" | "desc";
export type ListSort = { field: string; dir: SortDir };

export function parseListSort(
  raw: string | undefined,
  allowed: readonly string[],
  fallbackField: string,
  fallbackDir: SortDir = "desc",
): ListSort {
  const s = (raw || "").trim();
  if (!s) return { field: fallbackField, dir: fallbackDir };
  const m = s.match(/^(.+)_(asc|desc)$/);
  if (m && allowed.includes(m[1]!)) return { field: m[1]!, dir: m[2] as SortDir };
  if (allowed.includes(s)) return { field: s, dir: fallbackDir };
  return { field: fallbackField, dir: fallbackDir };
}

export function toggleSort(current: string | undefined, field: string, fallback = `${field}_desc`): string {
  const cur = current || fallback;
  if (cur === `${field}_desc`) return `${field}_asc`;
  return `${field}_desc`;
}
