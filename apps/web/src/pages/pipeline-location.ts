/** Location cell for a collapsed family. One country must not stand in for the rest. */
export function familyLocationLabel(
  locations: Array<string | null | undefined> | undefined,
  fallback?: string | null,
): { text: string; title: string } | null {
  const places = [...new Set((locations || []).map((s) => (s || "").trim()).filter(Boolean))];
  if (places.length > 1) {
    const title = places.join(", ");
    return { text: `${places[0]} +${places.length - 1}`, title };
  }
  const one = places[0] || (fallback || "").trim();
  return one ? { text: one, title: one } : null;
}
