import { createApiClient } from "@desk-ui/api-client";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";

export const client = createApiClient({ tokenKey: "job_scout_token" });
export const { api, apiMeta } = client;

/* ---------- shared row shapes (mirror apps/api) ---------- */

export type PipelineStatus =
  | "triaged"
  | "review"
  | "materials"
  | "applied"
  | "screen"
  | "interview"
  | "offer"
  | "rejected"
  | "skip"
  | "archived";

export const STATUSES: PipelineStatus[] = [
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
];

export type Verdict = "pass" | "marginal" | "fail";

export type PositionRow = {
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
  workplace: string | null;
  triageScore: number | null;
  triageVerdict: Verdict | null;
  triageOneLiner: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  locationRaw: string | null;
  listingStatus: string | null;
  watchEnabled: boolean;
  appliedAt: string | null;
  firstSeenAt: string | null;
  lastChangedAt: string | null;
  triagedAt: string | null;
  updatedAt: string;
  triageStale?: boolean;
  duplicateCount?: number;
  siblingCount?: number;
  familySalarySpan?: boolean;
  locations?: string[];
  siblings?: Array<{ id: string; title: string; status: string; location: string | null; url: string | null }>;
  repostOfId?: string | null;
  repost?: { appliedAt?: string | null; status?: string; reason?: string };
  company: { id: string; slug: string; name: string; website: string | null };
};

export type TriageJson = {
  score: number;
  archetype: number;
  comp: number;
  location: number;
  cvMatch: number;
  hardDq: string[];
  softFlags: string[];
  archetypeLabel?: string;
  compNote?: string;
  locationNote?: string;
  oneLiner: string;
  verdict?: Verdict;
  model?: string;
  at?: string;
};

export type PositionDetail = PositionRow & {
  companyId: string;
  atsJobId: string | null;
  externalIdentity: string | null;
  geoNotes: string | null;
  triageJson: TriageJson | null;
  triageModel: string | null;
  archiveReason: string | null;
  salaryRaw: string | null;
  salaryPeriod: string | null;
  equityNotes: string | null;
  employmentType: string | null;
  postedAt: string | null;
  departments: string[];
  source: string | null;
  contentHash: string | null;
  lastCheckedAt: string | null;
  closedAt: string | null;
  nextAction: string | null;
  notes: string | null;
  resumeSurface: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  company: {
    id: string;
    slug: string;
    name: string;
    website: string | null;
    careersUrl: string | null;
    industryTags: string[] | null;
    overview: string | null;
  };
  jd: { revision: number; descriptionText: string | null; techTags: string[] | null } | null;
  revisions: {
    id: string;
    revision: number;
    observedAt: string;
    changeKind: string;
    material: boolean;
    diffSummary: string | null;
    title: string | null;
    locationRaw: string | null;
    salaryRaw: string | null;
  }[];
  evaluations: {
    id: string;
    kind: "evaluate" | "jd_review" | "company_research";
    model: string | null;
    json: Record<string, unknown> | null;
    createdAt: string;
    tokensIn: number | null;
    tokensOut: number | null;
  }[];
  materials: {
    id: string;
    kind: string;
    version: number;
    isCurrent: boolean;
    status: string;
    model: string | null;
    createdAt: string;
    hasPdf: boolean;
  }[];
  questions?: { total: number; open: number; drafted: number };
};

export type Evaluation = {
  id: string;
  kind: string;
  model: string | null;
  markdown: string | null;
  json: Record<string, unknown> | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  createdAt: string;
};

export type Material = {
  id: string;
  positionId: string;
  kind: string;
  version: number;
  isCurrent: boolean;
  status: string;
  title: string | null;
  bodyMarkdown: string | null;
  pdfFileName: string | null;
  model: string | null;
  source: string | null;
  notes: string | null;
  createdAt: string;
};

export type TimelineEvent = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  actor: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
};

export type Revision = {
  id: string;
  revision: number;
  observedAt: string;
  changeKind: string;
  title: string | null;
  locationRaw: string | null;
  descriptionText: string | null;
  salaryRaw: string | null;
  techTags: string[] | null;
  diffSummary: string | null;
  fieldDiffs: { path: string; before: string | null; after: string | null }[] | null;
};

export type TodayData = {
  decisions: TodaySlim[];
  followUps: TodaySlim[];
  changed: TodaySlim[];
  upcoming: { id: string; positionId: string; stage: string; scheduledAt: string | null; status: string; title: string; company: string; slug: string }[];
  counts: { byStatus: Record<string, number>; untriaged: number; last30d: Record<string, number>; appliedThisWeek: number };
  queue: { status: string; type: string; c: number }[];
  llm: UsageSummary;
  approvals: Approval[];
  activity: ActivityRow[];
};

export type Person = {
  id: string;
  companyId: string;
  name: string;
  title: string | null;
  linkedinUrl: string | null;
  email: string | null;
  notes: string | null;
  createdAt: string;
};

export type Interview = {
  id: string;
  positionId: string;
  stage: string;
  title: string | null;
  interviewerName: string | null;
  interviewerRole: string | null;
  scheduledAt: string | null;
  occurredAt: string | null;
  durationSeconds: number | null;
  status: string;
  outcome: string | null;
  notes: string | null;
  notesMarkdown?: string | null;
  reviewMarkdown?: string | null;
  transcriptMarkdown?: string | null;
  transcriptSource: string | null;
  aiBriefMarkdown?: string | null;
  aiBriefJson?: Record<string, unknown> | null;
  aiBriefModel: string | null;
  aiBriefedAt: string | null;
  sourcePath: string | null;
  transcriptChars?: number;
  reviewChars?: number;
  notesMarkdownChars?: number;
  aiBriefChars?: number;
  briefJobId?: string | null;
  createdAt: string;
  updatedAt: string;
  positionTitle?: string;
  positionSlug?: string;
  positionStatus?: string;
  companyName?: string;
  companySlug?: string;
};

export type ProcessRound = {
  id: string;
  stage: string;
  title: string | null;
  interviewerName: string | null;
  scheduledAt: string | null;
  occurredAt: string | null;
  status: string;
  outcome: string | null;
  transcriptChars: number;
  aiBriefChars: number;
  aiBriefedAt: string | null;
};

export type ProcessRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  priority: string;
  nextAction: string | null;
  notes: string | null;
  appliedAt: string | null;
  updatedAt: string;
  company: { id: string; slug: string; name: string };
  roundCount: number;
  pendingCount: number;
  completedCount: number;
  lastRound: ProcessRound | null;
  nextRound: ProcessRound | null;
  rounds: ProcessRound[];
};

export type ActivityRow = {
  id: string;
  kind: string;
  title: string;
  actor: string | null;
  createdAt: string;
  positionId: string | null;
  slug: string | null;
  positionTitle: string | null;
  company: string | null;
};

export type ApprovalKind = "status_suggestion" | "materials_draft" | "archive_suggestion";
export type Approval = {
  id: string;
  kind: ApprovalKind;
  status: "pending" | "approved" | "dismissed" | "expired";
  positionId: string | null;
  companyId: string | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  source: string;
  createdAt: string;
  resolvedAt: string | null;
  position: { slug: string; title: string; status: string; company: string } | null;
};

export type ChatScope = "global" | "position" | "company";
export type ChatToolCall = { id: string; name: string; args: Record<string, unknown> };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  at: string;
  toolCalls?: ChatToolCall[];
  toolCallId?: string;
  toolName?: string;
  model?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
};
export type ChatThread = {
  id: string;
  scope: ChatScope;
  positionId: string | null;
  companyId: string | null;
  title: string | null;
  model: string | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};
export type ChatThreadRow = Omit<ChatThread, "messages"> & { messageCount: number; lastMessageAt?: string | null };

export type AutopilotPreset = "manual" | "assisted" | "autopilot" | "custom";
export type AutopilotConfig = {
  preset: AutopilotPreset;
  triageNew: boolean;
  evaluate: { mode: "off" | "threshold" | "all_pass"; minTriageScore: number };
  companyResearch: { mode: "off" | "on_evaluate" | "on_pass"; staleDays: number };
  jdReview: { mode: "off" | "hot_only" | "all_active" };
  materials: { mode: "off" | "threshold"; minEvaluateScore: number };
  suggestStatus: boolean;
  budget: { dailyCalls: number; dailyTokens: number };
};
export type AutopilotState = AutopilotConfig & {
  presets: Record<"manual" | "assisted" | "autopilot", Omit<AutopilotConfig, "preset" | "budget">>;
  summary: { pendingApprovals: number; untriaged: number; autoJobs24h: { type: string; status: string; c: number }[] };
  budgetToday: { calls: number; tokens: number };
};

export type BrowserStatus = {
  configured: boolean;
  baseUrl: string | null;
  healthUrl: string | null;
  ok: boolean;
  error: string | null;
  mcpUrl: string | null;
  owner: "job-scout";
};
export type TodaySlim = {
  id: string;
  slug: string;
  title: string;
  status: PipelineStatus;
  triageScore: number | null;
  triageVerdict: Verdict | null;
  triageOneLiner: string | null;
  listingStatus: string | null;
  appliedAt: string | null;
  lastChangedAt: string | null;
  updatedAt: string;
  company: { id: string; slug: string; name: string };
};

export type UsageSummary = {
  since: string;
  byOperation: { operation: string; runs: number; failures: number; tokensIn: number; tokensOut: number; avgLatencyMs: number; lastAt: string | null }[];
  today: Record<string, number>;
  remaining?: { operation: string; used: number; cap: number; remaining: number | null }[];
};

export type DiscoveryRow = {
  id: string;
  externalIdentity: string | null;
  company: string | null;
  title: string;
  url: string | null;
  locationRaw: string | null;
  craftFamily: string | null;
  geoClass: string | null;
  lane: "passed" | "filtered" | "marginal";
  gateReason: string | null;
  provider: string | null;
  observedAt: string;
  positionId: string | null;
  positionSlug: string | null;
  positionStatus: PipelineStatus | null;
  triageVerdict: Verdict | null;
  triageScore: number | null;
  copies?: number;
};

export type DeltaRow = {
  id: string;
  event: string;
  title: string | null;
  company: string | null;
  url: string | null;
  locationRaw: string | null;
  observedAt: string;
};

export type Board = {
  id: string;
  company: string;
  provider: string;
  token: string;
  careersUrl: string | null;
  enabled: boolean;
  sourceKind: string;
  tags: string[] | null;
  notes: string | null;
  lastScannedAt: string | null;
  lastError: string | null;
  errorKind: "missing" | "transient" | "auth" | "unknown" | "none";
};

export type Watch = {
  id: string;
  positionId: string | null;
  url: string;
  label: string | null;
  enabled: boolean;
  listingStatus: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
};

export type CompanyRow = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  careersUrl: string | null;
  industryTags: string[] | null;
  updatedAt: string;
  positionsTotal: number;
  positionsHot: number;
  positionsPass: number;
};

export type CompanyDetail = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  careersUrl: string | null;
  industryTags: string[] | null;
  overview: string | null;
  metadata: Record<string, unknown>;
  positions: { id: string; slug: string; title: string; status: PipelineStatus; triageScore: number | null; triageVerdict: Verdict | null; listingStatus: string | null; primaryUrl: string | null; updatedAt: string }[];
  research: Evaluation | null;
  boards: Board[];
};

export type NotifyChannel = "desk" | "new" | "process" | "research" | "chat";
export type NotificationsConfig = {
  enabled: boolean;
  session: string;
  minTriageScore: number;
  channels: Record<NotifyChannel, { enabled: boolean; chatId: string }>;
  events: {
    triage_pass: boolean;
    approval_pending: boolean;
    interview_scheduled: boolean;
    stale_applied: boolean;
    status_hot: boolean;
    jd_change_hot: boolean;
    listing_closed_hot: boolean;
    company_research: boolean;
  };
  quietHours: { enabled: boolean; timezone: string; start: string; end: string };
  chat: { model: string; allowFrom: string[]; cursorTs: number; cursorId: string };
};

export type Settings = {
  llm: {
    operations: Record<string, { model: string; enabled: boolean; dailyCap: number; temperature?: number }>;
    fallbackModel: string;
    modelsCatalog: { id: string; ownedBy?: string }[];
    modelsCatalogCachedAt: string | null;
  };
  gate: { titleInclude: string[]; titleExclude: string[]; geoAllow: string[]; geoBlock: string[]; maxPostingAgeDays: number; allowUnknownGeo: boolean };
  triage: { passThreshold: number; marginalThreshold: number; jdMaxChars: number; keepMarginal: boolean };
  retention: { snapshotsKeep: number; jobsDays: number; discoveryDays: number; deltasDays: number; llmRunsDays: number };
  scan: { boardIntervalMinutes: number; boardsPerTick: number; autoTriage: boolean };
  notifications?: NotificationsConfig;
};

export type Profile = {
  id: string;
  displayName: string;
  email: string | null;
  location: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  lastTitle: string | null;
  lastCompany: string | null;
  cashFloorUsd: number;
  northStar: string | null;
  targetRoles: string[] | null;
  resumeSurfaces: Record<string, string> | null;
  identityMarkdown: string | null;
  masterResumeMarkdown: string | null;
  masterCoverMarkdown: string | null;
  scoutBrief: string | null;
};

export type LlmStatus = {
  configured: boolean;
  baseUrl: string;
  fallbackModel: string;
  operations: {
    id: string;
    model: string;
    enabled: boolean;
    dailyCap: number;
    temperature?: number;
    today: number;
    last24h: UsageSummary["byOperation"][number] | null;
  }[];
  usage: UsageSummary;
};

export type ModelsCatalog = {
  models: { id: string; ownedBy?: string }[];
  groups: Record<string, string[]>;
  cachedAt: string | null;
  fromCache: boolean;
  error: string | null;
};

export type Job = {
  id: string;
  type: string;
  status: string;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  attempts: number;
  runAfter: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

export type SystemInfo = {
  version: string;
  authMode: string;
  publicBaseUrl: string | null;
  llmBaseUrl: string;
  llmConfigured: boolean;
  browser: BrowserStatus;
  jobs: { type: string; status: string; count: number }[];
};

export type ApiToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[] | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/* ---------- helpers ---------- */

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export function useApi<T>(key: unknown[], path: string, opts?: Partial<UseQueryOptions<T>>) {
  return useQuery<T>({ queryKey: key, queryFn: () => api<T>(path), ...opts });
}

export function useApiMeta<T>(key: unknown[], path: string, opts?: Partial<UseQueryOptions<{ data: T; meta: Record<string, unknown> }>>) {
  return useQuery<{ data: T; meta: Record<string, unknown> }>({ queryKey: key, queryFn: () => apiMeta<T>(path), ...opts });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: string[]) => {
    for (const p of prefixes) void qc.invalidateQueries({ queryKey: [p] });
  };
}

export function useAction<TVars = void, TOut = unknown>(fn: (v: TVars) => Promise<TOut>, invalidate: string[] = []) {
  const inv = useInvalidate();
  return useMutation<TOut, Error, TVars>({
    mutationFn: fn,
    onSuccess: () => inv(...invalidate),
  });
}

export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });
