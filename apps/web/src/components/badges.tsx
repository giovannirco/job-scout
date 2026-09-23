import { fitsHomeMarket } from "@job-scout/shared";
import type { PipelineStatus, Verdict } from "@/lib/api";
import { Chip, Dot, Meter, cn, type Tone } from "@/ui/kit";

export const STATUS_TONE: Record<PipelineStatus, Tone> = {
  triaged: "neutral",
  review: "accent",
  materials: "accent",
  applied: "info",
  screen: "good",
  interview: "good",
  offer: "good",
  rejected: "faint",
  skip: "faint",
  archived: "faint",
};

export const STATUS_LABEL: Record<PipelineStatus, string> = {
  triaged: "Triaged",
  review: "Review",
  materials: "Materials",
  applied: "Applied",
  screen: "Screen",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  skip: "Skipped",
  archived: "Archived",
};

/** The forward path a position walks. Terminal states live outside it. */
export const STATUS_PATH: PipelineStatus[] = ["triaged", "review", "materials", "applied", "screen", "interview", "offer"];
export const STATUS_TERMINAL: PipelineStatus[] = ["rejected", "skip", "archived"];

export function StatusBadge({ status, className }: { status: PipelineStatus | string; className?: string }) {
  const tone = STATUS_TONE[status as PipelineStatus] || "neutral";
  return (
    <Chip tone={tone} className={cn(status === "rejected" && "line-through", className)} mono={false}>
      <Dot tone={tone} />
      {STATUS_LABEL[status as PipelineStatus] || status}
    </Chip>
  );
}

export function verdictTone(v: Verdict | null | undefined): Tone {
  return v === "pass" ? "good" : v === "marginal" ? "warn" : v === "fail" ? "bad" : "faint";
}

export function VerdictBadge({ verdict, score, className }: { verdict: Verdict | null | undefined; score?: number | null; className?: string }) {
  if (!verdict) return <Chip tone="faint" className={className}>not scored</Chip>;
  return (
    <Chip tone={verdictTone(verdict)} className={className}>
      {verdict}
      {score != null ? <span className="opacity-80">{score.toFixed(1)}</span> : null}
    </Chip>
  );
}

/** Score meter colored by verdict when we have one. */
export function ScoreMeter({ score, verdict, className, size }: { score: number | null | undefined; verdict?: Verdict | null; className?: string; size?: "sm" | "md" }) {
  return <Meter value={score} tone={verdict ? verdictTone(verdict) : undefined} className={className} size={size} />;
}

export function ListingBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status || status === "open") return null;
  const tone: Tone = status === "closed" ? "bad" : status === "changed" ? "warn" : "neutral";
  return (
    <Chip tone={tone} className={className}>
      {status}
    </Chip>
  );
}

export function LaneBadge({ lane }: { lane: string }) {
  const tone: Tone = lane === "passed" ? "good" : lane === "marginal" ? "warn" : "faint";
  return <Chip tone={tone}>{lane}</Chip>;
}

export function WorkplaceChip({ workplace, className }: { workplace: string | null | undefined; className?: string }) {
  if (!workplace || workplace === "unknown") return <span className={cn("text-faint", className)}>—</span>;
  return <span className={cn("font-mono text-[11px] text-muted", className)}>{workplace}</span>;
}

export function GeoChip({ geo, remote, location, home, className }: { geo: string | null; remote?: string | null; location?: string | null; home?: string | null; className?: string }) {
  const raw = geo && geo !== "unknown" ? geo : remote && remote !== "unknown" ? remote : null;
  if (!raw) return <span className="text-faint">—</span>;
  if (fitsHomeMarket(geo, location, home)) return <span className={cn("font-mono text-[11px] text-good", className)} title="This place restriction matches your profile location">home</span>;
  const label = raw.replace(/_/g, " ").replace("worldwideish", "worldwide");
  const cls =
    geo === "brazil_friendly" || geo === "worldwideish"
      ? "text-good"
      : geo === "hard_geo"
        ? "text-bad"
        : "text-muted";
  return <span className={cn("font-mono text-[11px]", cls, className)}>{label}</span>;
}

export function ProviderChip({ provider }: { provider: string | null | undefined }) {
  if (!provider || provider === "unknown") return null;
  return (
    <Chip tone="faint" className="normal-case">
      {provider}
    </Chip>
  );
}
