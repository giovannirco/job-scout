import { z } from "zod";

export const PipelineStatus = z.enum([
  "triaged",
  "review",
  "materials",
  "applied",
  "screen",
  "interview",
  "offer",
  "rejected",
  "skip",
  "archived",
]);
export type PipelineStatus = z.infer<typeof PipelineStatus>;

/** Statuses that mean "I am actively working this" — never auto-archived. */
export const HOT_STATUSES: readonly PipelineStatus[] = [
  "review",
  "materials",
  "applied",
  "screen",
  "interview",
  "offer",
];

export const ListingStatus = z.enum(["open", "changed", "closed", "paused"]);
export type ListingStatus = z.infer<typeof ListingStatus>;

export const Priority = z.enum(["P0", "P1", "P2", "skip", "brazil-local"]);
export type Priority = z.infer<typeof Priority>;

export const CraftFamily = z.enum([
  "sre",
  "platform",
  "devops",
  "observability",
  "ai_infra",
  "infra",
  "release",
  "platform_adjacent",
  "software",
  "noise",
  "other",
  "unknown",
]);
export type CraftFamily = z.infer<typeof CraftFamily>;

export const GeoClass = z.enum([
  "brazil_friendly",
  "worldwideish",
  "ambiguous_remote",
  "hard_geo",
  "unknown",
]);
export type GeoClass = z.infer<typeof GeoClass>;

/** Kept for classify.ts compatibility; not persisted. */
export const MatchLabel = z.enum([
  "match",
  "geo_unknown",
  "hard_geo_maybe",
  "unmatched",
  "human_skip",
]);
export type MatchLabel = z.infer<typeof MatchLabel>;

export const Workplace = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export type Workplace = z.infer<typeof Workplace>;

export const RemoteClass = z.enum([
  "worldwide",
  "latam",
  "brazil",
  "americas",
  "us_only",
  "eu_only",
  "emea",
  "ambiguous_remote",
  "hybrid",
  "onsite",
  "unknown",
]);
export type RemoteClass = z.infer<typeof RemoteClass>;

export const AtsProvider = z.enum([
  "greenhouse",
  "ashby",
  "lever",
  "workday",
  "other",
  "unknown",
]);
export type AtsProvider = z.infer<typeof AtsProvider>;

export const ChangeKind = z.enum([
  "first_seen",
  "content",
  "title",
  "comp",
  "geo",
  "status",
  "closed",
  "reopened",
  "noise_rebase",
  "manual",
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

export const JobType = z.enum([
  "board_scan",
  "watch_check",
  "scan_url",
  "triage",
  "evaluate",
  "materials",
  "company_research",
  "jd_review",
  "listing_classify",
  "form_answers",
  "interview_brief",
  "retention",
]);
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof JobStatus>;

export type FieldDiff = {
  path: string;
  before: string | null;
  after: string | null;
};

export type SalaryParse = {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: "year" | "month" | "hour" | null;
  raw: string | null;
};

/** Slim position row returned by list endpoints (no metadata / JD text). */
export type PositionListRow = {
  id: string;
  slug: string;
  title: string;
  status: PipelineStatus;
  priority: string;
  primaryUrl: string | null;
  atsProvider: string | null;
  craftFamily: string | null;
  geoClass: string | null;
  remoteClass: string | null;
  triageScore: number | null;
  triageVerdict: "pass" | "marginal" | "fail" | null;
  triageOneLiner: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  listingStatus: string | null;
  watchEnabled: boolean;
  appliedAt: string | null;
  firstSeenAt: string | null;
  lastChangedAt: string | null;
  updatedAt: string;
  careerOps: CareerOpsStamp | null;
  company: { id: string; slug: string; name: string; website: string | null };
};

/** career-ops tracker link stored at positions.metadata.careerOps */
export type CareerOpsStamp = {
  trackerId?: string;
  score?: number;
  status?: string;
  reportPath?: string;
  pdfPath?: string;
  jdPath?: string;
  stampedAt?: string;
  [k: string]: unknown;
};
