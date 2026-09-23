export type AtsProvider =
  | "greenhouse"
  | "ashby"
  | "lever"
  | "workday"
  | "smartrecruiters"
  | "workable"
  | "teamtailor"
  | "rippling"
  | "bamboohr"
  | "linkedin"
  | "indeed"
  | "other"
  | "unknown";

export type AtsJob = {
  provider: AtsProvider;
  boardToken?: string;
  jobId?: string;
  externalIdentity?: string;
  title: string;
  company?: string;
  url: string;
  applyUrl?: string;
  locationRaw?: string;
  descriptionText?: string;
  descriptionHtml?: string;
  salaryRaw?: string;
  employmentType?: string;
  workplaceType?: string;
  isRemote?: boolean;
  departments?: string[];
  offices?: string[];
  requisitionId?: string;
  postedAt?: string;
  updatedAt?: string;
  /** Application form question prompts when available */
  questions?: string[];
  /** Set when the ATS form scrape ran and returned nothing usable */
  formHarvestError?: string;
  listingStatus: "open" | "closed" | "unknown";
  /** Full provider response / HTML extraction bag — always store when present */
  rawPayload?: Record<string, unknown>;
};

export type BoardJobSummary = {
  provider: string;
  boardToken: string;
  jobId: string;
  externalIdentity: string;
  title: string;
  url?: string;
  locationRaw?: string;
  workplaceType?: string;
  isRemote?: boolean;
  company: string;
  /** Original publication time, never the last edit or observation time. */
  postedAt?: string;
};

export type DetectedAts = {
  provider: AtsProvider;
  boardToken?: string;
  jobId?: string;
  url: string;
  /** True when URL is seed/fake and must not be scraped as a job page */
  placeholder?: boolean;
  confidence?: "high" | "medium" | "low";
};
