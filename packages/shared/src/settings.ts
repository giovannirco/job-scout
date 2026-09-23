import { z } from "zod";
import { DEFAULT_NOTIFICATIONS, type NotificationsConfig } from "./notify.js";

/**
 * Operator settings — a single jsonb row. Every knob the UI exposes lives here
 * so the worker and the API read one document.
 */

export const LLM_OPERATION_IDS = [
  "triage",
  "evaluate",
  "materials",
  "company_research",
  "jd_review",
  "chat",
  "listing_classify",
  "form_answers",
  "interview_brief",
] as const;
export type LlmOperationId = (typeof LLM_OPERATION_IDS)[number];

export const LlmOperationConfig = z.object({
  model: z.string().default(""),
  enabled: z.boolean().default(true),
  /** Max successful+failed runs per UTC day; 0 = unlimited */
  dailyCap: z.number().int().min(0).default(0),
  /** Optional per-operation temperature override */
  temperature: z.number().min(0).max(2).optional(),
});
export type LlmOperationConfig = z.infer<typeof LlmOperationConfig>;

/** When the per-operation model hits a provider quota/limit, retry on this id. Empty disables. */
export const DEFAULT_LLM_FALLBACK_MODEL = "grok-4.6";

export const GateConfig = z.object({
  titleInclude: z.array(z.string()).default([]),
  titleExclude: z.array(z.string()).default([]),
  geoAllow: z.array(z.string()).default([]),
  geoBlock: z.array(z.string()).default([]),
  /** Reject listings older than this many days when the board exposes a date; 0 = ignore */
  maxPostingAgeDays: z.number().int().min(0).default(14),
  /** Listings with unknown geo pass to triage instead of being filtered */
  allowUnknownGeo: z.boolean().default(true),
});
export type GateConfig = z.infer<typeof GateConfig>;

export const TriageConfig = z.object({
  /** score >= passThreshold => pass */
  passThreshold: z.number().min(0).max(5).default(3.5),
  /** score >= marginalThreshold (and < pass) => marginal, below => fail */
  marginalThreshold: z.number().min(0).max(5).default(3.0),
  /** Trim JD text to this many chars before sending to the model */
  jdMaxChars: z.number().int().min(500).default(6000),
  /** Automatically create/keep positions for marginal verdicts */
  keepMarginal: z.boolean().default(true),
});
export type TriageConfig = z.infer<typeof TriageConfig>;

export const RetentionConfig = z.object({
  snapshotsKeep: z.number().int().min(1).default(3),
  jobsDays: z.number().int().min(1).default(7),
  discoveryDays: z.number().int().min(1).default(30),
  deltasDays: z.number().int().min(1).default(30),
  llmRunsDays: z.number().int().min(1).default(90),
  /** Transcripts are far larger than the metadata row, so they age out sooner and the row survives for usage stats. */
  llmTranscriptDays: z.number().int().min(1).default(14),
});
export type RetentionConfig = z.infer<typeof RetentionConfig>;

/**
 * Autopilot — what the worker is allowed to do on its own after each event.
 * Presets are just named bundles of these knobs; `custom` means the operator edited them.
 */
export const AUTOPILOT_PRESETS = ["manual", "assisted", "autopilot", "custom"] as const;
export type AutopilotPreset = (typeof AUTOPILOT_PRESETS)[number];

export const AutopilotConfig = z.object({
  preset: z.enum(AUTOPILOT_PRESETS).default("assisted"),
  /** LLM-triage every listing that passes the deterministic gate */
  triageNew: z.boolean().default(true),
  /** Full A-H evaluation after triage */
  evaluate: z.object({
    mode: z.enum(["off", "threshold", "all_pass"]).default("threshold"),
    /** used when mode = threshold */
    minTriageScore: z.number().min(0).max(5).default(4.0),
  }),
  /** Company dossier */
  companyResearch: z.object({
    mode: z.enum(["off", "on_evaluate", "on_pass"]).default("on_evaluate"),
    /** Skip if the company already has research newer than this */
    staleDays: z.number().int().min(1).default(90),
  }),
  /** Re-review the JD when a material change lands */
  jdReview: z.object({
    mode: z.enum(["off", "hot_only", "all_active"]).default("hot_only"),
  }),
  /** Draft resume/cover materials — always land in the approval inbox */
  materials: z.object({
    mode: z.enum(["off", "threshold"]).default("off"),
    minEvaluateScore: z.number().min(0).max(5).default(3.5),
  }),
  /** After an evaluation, file a status suggestion (apply/skip) in the inbox */
  suggestStatus: z.boolean().default(true),
  /** Global hard stops across every operation, per UTC day. 0 = unlimited. */
  budget: z.object({
    dailyCalls: z.number().int().min(0).default(0),
    dailyTokens: z.number().int().min(0).default(0),
  }),
});
export type AutopilotConfig = z.infer<typeof AutopilotConfig>;

export const AUTOPILOT_PRESET_VALUES: Record<Exclude<AutopilotPreset, "custom">, Omit<AutopilotConfig, "preset" | "budget">> = {
  manual: {
    triageNew: false,
    evaluate: { mode: "off", minTriageScore: 4.0 },
    companyResearch: { mode: "off", staleDays: 90 },
    jdReview: { mode: "off" },
    materials: { mode: "off", minEvaluateScore: 3.5 },
    suggestStatus: false,
  },
  assisted: {
    triageNew: true,
    evaluate: { mode: "threshold", minTriageScore: 4.0 },
    companyResearch: { mode: "on_evaluate", staleDays: 90 },
    jdReview: { mode: "hot_only" },
    materials: { mode: "off", minEvaluateScore: 3.5 },
    suggestStatus: true,
  },
  autopilot: {
    triageNew: true,
    evaluate: { mode: "all_pass", minTriageScore: 3.5 },
    companyResearch: { mode: "on_pass", staleDays: 60 },
    jdReview: { mode: "all_active" },
    materials: { mode: "threshold", minEvaluateScore: 3.5 },
    suggestStatus: true,
  },
};

/** Return the config for a preset, keeping the current budget. */
export function applyAutopilotPreset(current: AutopilotConfig, preset: Exclude<AutopilotPreset, "custom">): AutopilotConfig {
  return { ...current, ...AUTOPILOT_PRESET_VALUES[preset], preset };
}

/** Name the preset a config matches, or `custom`. */
export function detectAutopilotPreset(cfg: AutopilotConfig): AutopilotPreset {
  for (const name of ["manual", "assisted", "autopilot"] as const) {
    const p = AUTOPILOT_PRESET_VALUES[name];
    const same =
      p.triageNew === cfg.triageNew &&
      p.evaluate.mode === cfg.evaluate.mode &&
      p.evaluate.minTriageScore === cfg.evaluate.minTriageScore &&
      p.companyResearch.mode === cfg.companyResearch.mode &&
      p.companyResearch.staleDays === cfg.companyResearch.staleDays &&
      p.jdReview.mode === cfg.jdReview.mode &&
      p.materials.mode === cfg.materials.mode &&
      p.materials.minEvaluateScore === cfg.materials.minEvaluateScore &&
      p.suggestStatus === cfg.suggestStatus;
    if (same) return name;
  }
  return "custom";
}

const NotifyChannelCfg = z.object({
  enabled: z.boolean().default(true),
  chatId: z.string().default(""),
});

export const NotificationsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  session: z.string().default("default"),
  minTriageScore: z.number().min(0).max(5).default(3.5),
  channels: z.object({
    desk: NotifyChannelCfg,
    new: NotifyChannelCfg,
    process: NotifyChannelCfg,
    research: NotifyChannelCfg,
    chat: NotifyChannelCfg,
  }),
  events: z.object({
    triage_pass: z.boolean().default(true),
    approval_pending: z.boolean().default(true),
    interview_scheduled: z.boolean().default(true),
    stale_applied: z.boolean().default(true),
    status_hot: z.boolean().default(true),
    jd_change_hot: z.boolean().default(true),
    listing_closed_hot: z.boolean().default(true),
    company_research: z.boolean().default(true),
  }),
  quietHours: z.object({
    enabled: z.boolean().default(true),
    timezone: z.string().default("UTC"),
    start: z.string().default("23:00"),
    end: z.string().default("08:00"),
  }),
  chat: z.object({
    model: z.string().default("grok-4.6"),
    allowFrom: z.array(z.string()).default([]),
    cursorTs: z.number().default(0),
    cursorId: z.string().default(""),
  }),
});
export type { NotificationsConfig };

export const ChatConfig = z.object({
  /** Let the chat agent drive the job-scout Steel browser through Playwright MCP */
  browserTools: z.boolean().default(true),
  /** Let the chat agent change position status / notes directly (else it only proposes) */
  writeTools: z.boolean().default(true),
  /** Max tool-call rounds per user message */
  maxSteps: z.number().int().min(1).max(30).default(12),
});
export type ChatConfig = z.infer<typeof ChatConfig>;

export const Settings = z.object({
  llm: z.object({
    operations: z.record(z.string(), LlmOperationConfig).default({}),
    fallbackModel: z.string().default(DEFAULT_LLM_FALLBACK_MODEL),
    /** Cached /v1/models catalog */
    modelsCatalog: z
      .array(z.object({ id: z.string(), ownedBy: z.string().optional() }))
      .default([]),
    modelsCatalogCachedAt: z.string().nullable().default(null),
  }),
  gate: GateConfig,
  triage: TriageConfig,
  retention: RetentionConfig,
  scan: z.object({
    /** Minutes between scans of the same board */
    boardIntervalMinutes: z.number().int().min(5).default(30),
    /** Max boards per discovery tick */
    boardsPerTick: z.number().int().min(1).default(40),
    /** @deprecated superseded by autopilot.triageNew; kept so stored documents still parse */
    autoTriage: z.boolean().default(true),
  }),
  autopilot: AutopilotConfig,
  chat: ChatConfig,
  notifications: NotificationsConfigSchema,
  listingFactsBackfillAt: z.string().nullable().optional(),
  listingFactsBackfillVersion: z.string().nullable().optional(),
  /** One-shot repair for discovery promotions stored as source "manual" before scan:discovery. */
  misstampWithdrawVersion: z.string().nullable().optional(),
  /** One-shot withdraw of office filings the gate used to treat as unknown geo. */
  officeGateVersion: z.string().nullable().optional(),
  /** One-shot: discovery rows stay filtered after the filing is archived for the gate. */
  gateLaneVersion: z.string().nullable().optional(),
  /** One-shot: a US profile location drops remote roles that require another country. */
  homeGateVersion: z.string().nullable().optional(),
  /** One-shot: north star excludes, US-only wording, and age on jobs the board still lists. */
  profileGateVersion: z.string().nullable().optional(),
  /** One-shot: re-gate after city offices and graduate titles classify correctly. */
  placeSplitVersion: z.string().nullable().optional(),
  /** One-shot: careers-page filings with no location are refetched from the greenhouse board. */
  blankGreenhouseVersion: z.string().nullable().optional(),
  /** One-shot: N/A and HQ locations are replaced from the office or street address. */
  junkPlaceVersion: z.string().nullable().optional(),
  /** One-shot: named HTML entities left in stored job descriptions. */
  entityDecodeVersion: z.string().nullable().optional(),
  /** One-shot: a backend north star drops frontend, SRE, data engineering, support, solutions, and QA titles. */
  craftGateVersion: z.string().nullable().optional(),
  /** One-shot: software titles get a craft, and aggregator rows show the employer. */
  labelVersion: z.string().nullable().optional(),
  /** One-shot: a title region that disagrees with the stored place is refetched from the office. */
  regionOfficeVersion: z.string().nullable().optional(),
  /** One-shot: a stringified salary object is replaced with the posted range. */
  salaryObjectVersion: z.string().nullable().optional(),
  /** One-shot: a US city list that also says remote is a home place, not an unknown geo. */
  usPlaceGeoVersion: z.string().nullable().optional(),
  /** One-shot: discovery rows for an archived filing leave the passed lane. */
  archivedDiscoveryVersion: z.string().nullable().optional(),
  /** One-shot: a hyphen glued to a word gets a space, as in "Engineer- Money". */
  titleHyphenVersion: z.string().nullable().optional(),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_GATE: GateConfig = {
  titleInclude: [
    "sre",
    "site reliability",
    "platform engineer",
    "devops",
    "infrastructure",
    "kubernetes",
  ],
  titleExclude: [
    "manager",
    "director",
    "intern",
    "junior",
    "new grad",
    "early career",
    "sales",
    "recruiter",
    "dba",
  ],
  geoAllow: ["remote", "worldwide", "global", "anywhere", "distributed"],
  geoBlock: ["us only", "usa only", "on-site", "onsite", "hybrid", "clearance"],
  maxPostingAgeDays: 14,
  allowUnknownGeo: true,
};

export const DEFAULT_SETTINGS: Settings = {
  llm: {
    fallbackModel: DEFAULT_LLM_FALLBACK_MODEL,
    operations: {
      triage: { model: "", enabled: true, dailyCap: 300 },
      evaluate: { model: "", enabled: true, dailyCap: 40 },
      materials: { model: "", enabled: true, dailyCap: 20 },
      company_research: { model: "", enabled: true, dailyCap: 20 },
      jd_review: { model: "", enabled: true, dailyCap: 40 },
      chat: { model: "", enabled: true, dailyCap: 400 },
      listing_classify: { model: "", enabled: true, dailyCap: 200 },
      form_answers: { model: "", enabled: true, dailyCap: 40 },
      interview_brief: { model: "", enabled: true, dailyCap: 40 },
    },
    modelsCatalog: [],
    modelsCatalogCachedAt: null,
  },
  gate: DEFAULT_GATE,
  triage: { passThreshold: 3.5, marginalThreshold: 3.0, jdMaxChars: 6000, keepMarginal: true },
  retention: { snapshotsKeep: 3, jobsDays: 7, discoveryDays: 30, deltasDays: 30, llmRunsDays: 90, llmTranscriptDays: 14 },
  scan: { boardIntervalMinutes: 30, boardsPerTick: 40, autoTriage: true },
  autopilot: { preset: "assisted", budget: { dailyCalls: 0, dailyTokens: 0 }, ...AUTOPILOT_PRESET_VALUES.assisted },
  chat: { browserTools: true, writeTools: true, maxSteps: 12 },
  notifications: DEFAULT_NOTIFICATIONS,
};

/** Deep-merge a stored partial settings document over the defaults and validate. */
export function resolveSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const merged = {
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...(s.llm as object | undefined),
      operations: {
        ...DEFAULT_SETTINGS.llm.operations,
        ...(((s.llm as { operations?: Record<string, unknown> } | undefined)?.operations) || {}),
      },
    },
    gate: { ...DEFAULT_SETTINGS.gate, ...(s.gate as object | undefined) },
    triage: { ...DEFAULT_SETTINGS.triage, ...(s.triage as object | undefined) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(s.retention as object | undefined) },
    scan: { ...DEFAULT_SETTINGS.scan, ...(s.scan as object | undefined) },
    autopilot: mergeAutopilot(s.autopilot),
    chat: { ...DEFAULT_SETTINGS.chat, ...(s.chat as object | undefined) },
    notifications: mergeNotifications(s.notifications),
    listingFactsBackfillAt: typeof s.listingFactsBackfillAt === "string" ? s.listingFactsBackfillAt : null,
    listingFactsBackfillVersion: typeof s.listingFactsBackfillVersion === "string" ? s.listingFactsBackfillVersion : null,
    misstampWithdrawVersion: typeof s.misstampWithdrawVersion === "string" ? s.misstampWithdrawVersion : null,
    officeGateVersion: typeof s.officeGateVersion === "string" ? s.officeGateVersion : null,
    gateLaneVersion: typeof s.gateLaneVersion === "string" ? s.gateLaneVersion : null,
    homeGateVersion: typeof s.homeGateVersion === "string" ? s.homeGateVersion : null,
    profileGateVersion: typeof s.profileGateVersion === "string" ? s.profileGateVersion : null,
    placeSplitVersion: typeof s.placeSplitVersion === "string" ? s.placeSplitVersion : null,
  };
  return Settings.parse(merged);
}

function mergeNotifications(stored: unknown): NotificationsConfig {
  const d = DEFAULT_NOTIFICATIONS;
  const n = (stored && typeof stored === "object" ? stored : {}) as Partial<NotificationsConfig>;
  const ch = (n.channels && typeof n.channels === "object" ? n.channels : {}) as Partial<NotificationsConfig["channels"]>;
  const ev = (n.events && typeof n.events === "object" ? n.events : {}) as Partial<NotificationsConfig["events"]>;
  const qh = (n.quietHours && typeof n.quietHours === "object" ? n.quietHours : {}) as Partial<NotificationsConfig["quietHours"]>;
  const chat = (n.chat && typeof n.chat === "object" ? n.chat : {}) as Partial<NotificationsConfig["chat"]>;
  return {
    enabled: n.enabled ?? d.enabled,
    session: typeof n.session === "string" ? n.session : d.session,
    minTriageScore: typeof n.minTriageScore === "number" ? n.minTriageScore : d.minTriageScore,
    channels: {
      desk: { ...d.channels.desk, ...ch.desk },
      new: { ...d.channels.new, ...ch.new },
      process: { ...d.channels.process, ...ch.process },
      research: { ...d.channels.research, ...ch.research },
      chat: { ...d.channels.chat, ...ch.chat },
    },
    events: { ...d.events, ...ev },
    quietHours: { ...d.quietHours, ...qh },
    chat: {
      ...d.chat,
      ...chat,
      allowFrom: Array.isArray(chat.allowFrom) ? chat.allowFrom : d.chat.allowFrom,
    },
  };
}

function mergeAutopilot(stored: unknown): AutopilotConfig {
  const d = DEFAULT_SETTINGS.autopilot;
  const a = (stored && typeof stored === "object" ? stored : {}) as Partial<Record<keyof AutopilotConfig, unknown>>;
  const obj = (k: keyof AutopilotConfig) => (a[k] && typeof a[k] === "object" ? (a[k] as object) : {});
  const merged: AutopilotConfig = {
    ...d,
    ...(a as object),
    evaluate: { ...d.evaluate, ...obj("evaluate") },
    companyResearch: { ...d.companyResearch, ...obj("companyResearch") },
    jdReview: { ...d.jdReview, ...obj("jdReview") },
    materials: { ...d.materials, ...obj("materials") },
    budget: { ...d.budget, ...obj("budget") },
  } as AutopilotConfig;
  // preset is derived, never trusted from storage
  merged.preset = detectAutopilotPreset(merged);
  return merged;
}
