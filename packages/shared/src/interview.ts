export const INTERVIEW_STAGES = ["screen", "hiring_manager", "technical", "onsite", "offer", "other"] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

export const INTERVIEW_STATUSES = ["pending", "completed", "cancelled"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_OUTCOMES = ["advanced", "hold", "rejected", "cancelled", "unclear"] as const;
export type InterviewOutcome = (typeof INTERVIEW_OUTCOMES)[number];

export const PROCESS_STATUSES = ["applied", "screen", "interview", "offer"] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];
