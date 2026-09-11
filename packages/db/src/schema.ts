import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * job-scout schema.
 *
 * Compared to v1: the Buzz/Hermes harness tables are gone, the 20 `llm_fit_*` /
 * `jd_review_*` columns on positions collapsed into `triage_*` + an
 * `evaluations` table, LLM usage is logged in `llm_runs`, and operator
 * configuration lives in a single-row `settings` table.
 */

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  location: text("location"),
  linkedinUrl: text("linkedin_url"),
  githubUrl: text("github_url"),
  lastTitle: text("last_title"),
  lastCompany: text("last_company"),
  cashFloorUsd: integer("cash_floor_usd").notNull().default(0),
  northStar: text("north_star"),
  targetRoles: jsonb("target_roles").$type<string[]>().default([]),
  resumeSurfaces: jsonb("resume_surfaces").$type<Record<string, string>>().default({}),
  /** Who I am — used by evaluate/materials prompts */
  identityMarkdown: text("identity_markdown"),
  /** Master resume markdown — base for evaluate + materials */
  masterResumeMarkdown: text("master_resume_markdown"),
  /** Master cover letter template */
  masterCoverMarkdown: text("master_cover_markdown"),
  /** Compact scout brief for the cheap triage model (archetypes, DQs, comp floor) */
  scoutBrief: text("scout_brief"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable(
  "companies",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    website: text("website"),
    careersUrl: text("careers_url"),
    industryTags: jsonb("industry_tags").$type<string[]>().default([]),
    overview: text("overview"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("companies_slug_uidx").on(t.slug)],
);

export const POSITION_STATUSES = [
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
] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export const TRIAGE_VERDICTS = ["pass", "marginal", "fail"] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export const positions = pgTable(
  "positions",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<PositionStatus>().notNull().default("triaged"),
    priority: text("priority").notNull().default("P2"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    resumeSurface: text("resume_surface"),
    primaryUrl: text("primary_url"),
    atsProvider: text("ats_provider").default("unknown"),
    atsJobId: text("ats_job_id"),
    atsBoardToken: text("ats_board_token"),
    externalIdentity: text("external_identity"),
    craftFamily: text("craft_family").default("unknown"),
    geoClass: text("geo_class").default("unknown"),
    remoteClass: text("remote_class").default("unknown"),
    workplace: text("workplace").default("unknown"),
    geoNotes: text("geo_notes"),
    /** LLM triage (cheap model) */
    triageScore: real("triage_score"),
    triageVerdict: text("triage_verdict").$type<TriageVerdict>(),
    triageJson: jsonb("triage_json").$type<Record<string, unknown>>(),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    triageModel: text("triage_model"),
    /** Why a position is archived (bulk import, gate, user, closed) */
    archiveReason: text("archive_reason"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period"),
    salaryRaw: text("salary_raw"),
    equityNotes: text("equity_notes"),
    employmentType: text("employment_type"),
    source: text("source"),
    watchEnabled: boolean("watch_enabled").notNull().default(false),
    contentHash: text("content_hash"),
    listingStatus: text("listing_status").default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    nextAction: text("next_action"),
    notes: text("notes"),
    /** career-ops reconcile stamp, ATS meta, misc. Never returned in lists. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("positions_slug_uidx").on(t.slug),
    index("positions_status_idx").on(t.status),
    index("positions_company_idx").on(t.companyId),
    index("positions_external_idx").on(t.externalIdentity),
    index("positions_verdict_idx").on(t.triageVerdict),
    index("positions_updated_idx").on(t.updatedAt),
  ],
);

export const jdRevisions = pgTable(
  "jd_revisions",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    contentHash: text("content_hash").notNull(),
    changeKind: text("change_kind").notNull(),
    material: boolean("material").notNull().default(true),
    title: text("title"),
    locationRaw: text("location_raw"),
    descriptionText: text("description_text"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    salaryCurrency: text("salary_currency"),
    salaryPeriod: text("salary_period"),
    salaryRaw: text("salary_raw"),
    techTags: jsonb("tech_tags").$type<string[]>().default([]),
    remoteClass: text("remote_class"),
    geoClass: text("geo_class"),
    diffSummary: text("diff_summary"),
    fieldDiffs: jsonb("field_diffs")
      .$type<{ path: string; before: string | null; after: string | null }[]>()
      .default([]),
    source: text("source").default("scan"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jd_revisions_pos_rev_uidx").on(t.positionId, t.revision),
    index("jd_revisions_position_idx").on(t.positionId),
  ],
);

export const timelineEvents = pgTable(
  "timeline_events",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id").references(() => positions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("note"),
    title: text("title").notNull(),
    body: text("body"),
    actor: text("actor").default("system"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("timeline_position_idx").on(t.positionId),
    index("timeline_occurred_idx").on(t.occurredAt),
  ],
);

export const watches = pgTable(
  "watches",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id").references(() => positions.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    contentHash: text("content_hash"),
    listingStatus: text("listing_status").default("open"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("watches_enabled_idx").on(t.enabled)],
);

export const boardSources = pgTable(
  "board_sources",
  {
    id: text("id").primaryKey(),
    company: text("company").notNull(),
    provider: text("provider").notNull(),
    token: text("token").notNull(),
    careersUrl: text("careers_url"),
    enabled: boolean("enabled").notNull().default(true),
    sourceKind: text("source_kind").notNull().default("ats"),
    tags: jsonb("tags").$type<string[]>().default([]),
    notes: text("notes"),
    capability: text("capability").default("list_api"),
    lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("board_sources_provider_token_uidx").on(t.provider, t.token)],
);

/** Latest identities per board. Retention keeps the last N per board. No raw payload. */
export const boardSnapshots = pgTable(
  "board_snapshots",
  {
    id: text("id").primaryKey(),
    boardSourceId: text("board_source_id").references(() => boardSources.id, {
      onDelete: "cascade",
    }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    jobCount: integer("job_count").default(0),
    matchCount: integer("match_count").default(0),
    identities: jsonb("identities").$type<unknown[]>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("board_snapshots_board_observed_idx").on(t.boardSourceId, t.observedAt)],
);

export const boardDeltas = pgTable(
  "board_deltas",
  {
    id: text("id").primaryKey(),
    boardSourceId: text("board_source_id").references(() => boardSources.id, {
      onDelete: "cascade",
    }),
    event: text("event").notNull(),
    externalIdentity: text("external_identity"),
    title: text("title"),
    company: text("company"),
    url: text("url"),
    locationRaw: text("location_raw"),
    craftFamily: text("craft_family"),
    geoClass: text("geo_class"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("board_deltas_observed_idx").on(t.observedAt)],
);

export const DISCOVERY_LANES = ["passed", "filtered", "marginal"] as const;
export type DiscoveryLane = (typeof DISCOVERY_LANES)[number];

/** Everything a scan saw, with the gate verdict. Radar reads this. */
export const discoveryFeed = pgTable(
  "discovery_feed",
  {
    id: text("id").primaryKey(),
    externalIdentity: text("external_identity"),
    boardSourceId: text("board_source_id").references(() => boardSources.id, {
      onDelete: "set null",
    }),
    company: text("company"),
    title: text("title").notNull(),
    url: text("url"),
    locationRaw: text("location_raw"),
    craftFamily: text("craft_family"),
    geoClass: text("geo_class"),
    lane: text("lane").$type<DiscoveryLane>().notNull().default("filtered"),
    gateReason: text("gate_reason"),
    positionId: text("position_id").references(() => positions.id, { onDelete: "set null" }),
    provider: text("provider"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("discovery_lane_idx").on(t.lane),
    index("discovery_observed_idx").on(t.observedAt),
    uniqueIndex("discovery_external_uidx").on(t.externalIdentity),
  ],
);

export const JOB_TYPES = [
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
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").$type<JobType>().notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    result: jsonb("result").$type<Record<string, unknown>>().default({}),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_status_run_idx").on(t.status, t.runAfter),
    index("jobs_created_idx").on(t.createdAt),
  ],
);

export const people = pgTable("people", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  name: text("name").notNull(),
  title: text("title"),
  linkedinUrl: text("linkedin_url"),
  email: text("email"),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const interviews = pgTable(
  "interviews",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    stage: text("stage").notNull().default("screen"),
    title: text("title"),
    interviewerName: text("interviewer_name"),
    interviewerRole: text("interviewer_role"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    status: text("status").notNull().default("pending"),
    outcome: text("outcome"),
    notes: text("notes"),
    notesMarkdown: text("notes_markdown"),
    reviewMarkdown: text("review_markdown"),
    transcriptMarkdown: text("transcript_markdown"),
    transcriptSource: text("transcript_source"),
    aiBriefMarkdown: text("ai_brief_markdown"),
    aiBriefJson: jsonb("ai_brief_json").$type<Record<string, unknown>>(),
    aiBriefModel: text("ai_brief_model"),
    aiBriefedAt: timestamp("ai_briefed_at", { withTimezone: true }),
    sourcePath: text("source_path"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("interviews_position_idx").on(t.positionId)],
);

export const outreachEvents = pgTable("outreach_events", {
  id: text("id").primaryKey(),
  positionId: text("position_id").references(() => positions.id, { onDelete: "set null" }),
  companyId: text("company_id").references(() => companies.id),
  channel: text("channel").notNull().default("email"),
  who: text("who"),
  note: text("note"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiTokens = pgTable("api_tokens", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  scopes: jsonb("scopes").$type<string[]>().default(["agent"]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Versioned resume/cover artifacts per position. */
export const applicationMaterials = pgTable(
  "application_materials",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // resume | cover
    version: integer("version").notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(true),
    status: text("status").notNull().default("ready"), // pending | ready | failed
    title: text("title"),
    bodyMarkdown: text("body_markdown"),
    pdfBase64: text("pdf_base64"),
    pdfFileName: text("pdf_file_name"),
    model: text("model"),
    source: text("source").default("llm"),
    notes: text("notes"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("app_materials_position_idx").on(t.positionId),
    uniqueIndex("app_materials_pos_kind_ver_uidx").on(t.positionId, t.kind, t.version),
  ],
);

/** Application form questions + drafted answers. */
export const applicationQuestions = pgTable(
  "application_questions",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    question: text("question").notNull(),
    answer: text("answer"),
    required: boolean("required").notNull().default(false),
    inputType: text("input_type"),
    status: text("status").notNull().default("open"), // open | answered | skipped
    source: text("source").default("human"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("app_questions_position_idx").on(t.positionId), uniqueIndex("app_questions_pos_q_uidx").on(t.positionId, t.question)],
);

export const EVALUATION_KINDS = ["evaluate", "jd_review", "company_research"] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

/** LLM outputs that are documents (evaluate A-H, JD review, company research). */
export const evaluations = pgTable(
  "evaluations",
  {
    id: text("id").primaryKey(),
    positionId: text("position_id").references(() => positions.id, { onDelete: "cascade" }),
    companyId: text("company_id").references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").$type<EvaluationKind>().notNull(),
    model: text("model"),
    markdown: text("markdown"),
    json: jsonb("json").$type<Record<string, unknown>>(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("evaluations_position_idx").on(t.positionId),
    index("evaluations_company_idx").on(t.companyId),
    index("evaluations_kind_created_idx").on(t.kind, t.createdAt),
  ],
);

export const LLM_OPERATIONS = [
  "triage",
  "evaluate",
  "materials",
  "company_research",
  "jd_review",
  "chat",
  "test",
  "listing_classify",
  "form_answers",
  "interview_brief",
] as const;
export type LlmOperation = (typeof LLM_OPERATIONS)[number];

/** One row per model call. Drives the Settings > AI usage view and daily caps. */
export const llmRuns = pgTable(
  "llm_runs",
  {
    id: text("id").primaryKey(),
    operation: text("operation").$type<LlmOperation>().notNull(),
    model: text("model").notNull(),
    positionId: text("position_id"),
    status: text("status").notNull().default("ok"), // ok | error
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    /** Application messages before schema hints/provider formatting/retries, truncated. */
    prompt: text("prompt"),
    /** What the model returned: assistant content, truncated. */
    response: text("response"),
    /** Untruncated sizes, so the UI can say how much was cut. */
    promptChars: integer("prompt_chars"),
    responseChars: integer("response_chars"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("llm_runs_created_idx").on(t.createdAt),
    index("llm_runs_op_created_idx").on(t.operation, t.createdAt),
    index("llm_runs_position_idx").on(t.positionId),
  ],
);

/** Single-row operator settings (id = "default"). Shape in @job-scout/shared Settings. */
export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const APPROVAL_KINDS = ["status_suggestion", "materials_draft", "archive_suggestion"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "dismissed", "expired"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Autopilot inbox: things the worker did or wants to do that a human should look at.
 * `payload` carries the proposed action (e.g. { toStatus, reason, evaluationId }).
 */
export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ApprovalKind>().notNull(),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    positionId: text("position_id").references(() => positions.id, { onDelete: "cascade" }),
    companyId: text("company_id").references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
    /** who produced it: autopilot | chat */
    source: text("source").notNull().default("autopilot"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("approvals_status_created_idx").on(t.status, t.createdAt),
    index("approvals_position_idx").on(t.positionId),
  ],
);

export const CHAT_SCOPES = ["global", "position", "company"] as const;
export type ChatScope = (typeof CHAT_SCOPES)[number];

export type ChatMessageRow = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  at: string;
  /** assistant: tool calls it issued; tool: the call it answers */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolCallId?: string;
  toolName?: string;
  model?: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
};

/** Chat threads with the agent. Messages are a jsonb array — threads are short-lived and per-scope. */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: text("id").primaryKey(),
    scope: text("scope").$type<ChatScope>().notNull().default("global"),
    positionId: text("position_id").references(() => positions.id, { onDelete: "cascade" }),
    companyId: text("company_id").references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"),
    model: text("model"),
    messages: jsonb("messages").$type<ChatMessageRow[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_threads_scope_idx").on(t.scope, t.positionId, t.companyId), index("chat_threads_updated_idx").on(t.updatedAt)],
);

export const schema = {
  profiles,
  companies,
  positions,
  jdRevisions,
  timelineEvents,
  watches,
  boardSources,
  boardSnapshots,
  boardDeltas,
  discoveryFeed,
  jobs,
  people,
  interviews,
  outreachEvents,
  apiTokens,
  applicationMaterials,
  applicationQuestions,
  evaluations,
  llmRuns,
  settings,
  approvals,
  chatThreads,
};
