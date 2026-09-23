/** A first snapshot stamps Changed at the same moment as First seen. That is not an edit. */
export function jdChangedAt(firstSeenAt?: string | null, lastChangedAt?: string | null): string | null {
  if (!lastChangedAt) return null;
  if (!firstSeenAt) return lastChangedAt;
  const first = new Date(firstSeenAt).getTime();
  const changed = new Date(lastChangedAt).getTime();
  if (Number.isNaN(first) || Number.isNaN(changed)) return lastChangedAt;
  if (Math.abs(changed - first) < 1000) return null;
  return lastChangedAt;
}

export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 24) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function dateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function money(min: number | null, max: number | null, cur: string | null): string {
  if (min == null && max == null) return "";
  const c = cur || "USD";
  const f = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const sym = c === "USD" ? "$" : c === "EUR" ? "€" : c === "GBP" ? "£" : c === "BRL" ? "R$" : `${c} `;
  if (min != null && max != null && min !== max) {
    const right = sym.endsWith(" ") ? f(max) : `${sym}${f(max)}`;
    return `${sym}${f(min)}–${right}`;
  }
  return `${sym}${f((min ?? max) as number)}`;
}

export function score(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toFixed(1);
}

export function compact(n: number | null | undefined): string {
  if (n == null) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const EMPLOYMENT_LABELS: Record<string, string> = {
  fulltime: "Full-time",
  full_time: "Full-time",
  parttime: "Part-time",
  part_time: "Part-time",
  contractor: "Contract",
  contract: "Contract",
  temporary: "Temporary",
  intern: "Intern",
  internship: "Intern",
  volunteer: "Volunteer",
  perdiem: "Per diem",
  per_diem: "Per diem",
};

/** Schema.org values such as FullTime and FULL_TIME read as "Full-time". */
export function employmentLabel(raw: string | null | undefined): string {
  const text = (raw || "").trim();
  if (!text) return "";
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  return EMPLOYMENT_LABELS[key] || EMPLOYMENT_LABELS[key.replace(/_/g, "")] || text;
}

const SCAN_SOURCE: Record<string, string> = {
  discovery: "discovery",
  greenhouse: "Greenhouse",
  ashby: "Ashby",
  lever: "Lever",
  remoteok: "Remote OK",
};

/** Stored creation lines name the scanner. The history tab should name the place. */
export function sourceLabel(source: string | null | undefined): string {
  const text = (source || "").trim();
  if (!text) return "";
  if (text === "manual") return "added by hand";
  const scan = text.match(/^scan:([a-z0-9]+)$/i);
  if (!scan) return text;
  const key = scan[1].toLowerCase();
  if (key === "discovery") return "discovery";
  return SCAN_SOURCE[key] || scan[1];
}

export function createdFromLabel(title: string | null | undefined): string {
  const text = title || "";
  const scan = text.match(/^Created from (scan:[a-z0-9]+|manual)$/i);
  if (!scan) return text;
  const label = sourceLabel(scan[1]);
  if (label === "discovery") return "Created from discovery";
  if (label === "added by hand") return "Added by hand";
  return `Created from ${label}`;
}

/** A question with status open has not been answered yet. */
export function questionStatusLabel(status: string | null | undefined): string {
  if (status === "open") return "unanswered";
  if (!status) return "";
  return status.replace(/_/g, " ");
}

/** Collapse the blank runs some boards leave between JD sections. */
export function readableJd(text: string | null | undefined): string {
  return (text || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function host(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
