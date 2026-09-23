/** Plain label for a stored gate reason. The raw code stays available as a tooltip. */
export function gateReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "—";
  if (reason === "title_no_include") return "title not in your roles";
  if (reason === "junk_title") return "unreadable title";
  if (reason === "geo_unknown") return "no location";
  if (reason === "geo_unlisted") return "location not allowed";
  if (reason.startsWith("title_exclude:")) return `excluded: ${reason.slice("title_exclude:".length)}`;
  if (reason.startsWith("stale:")) return `older than the age limit (${reason.slice("stale:".length)})`;
  if (reason.startsWith("geo_block:")) return `location blocked: ${reason.slice("geo_block:".length)}`;
  return reason;
}
