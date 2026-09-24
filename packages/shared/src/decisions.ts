import { z } from "zod";

export const DecisionMode = z.enum(["off", "observe", "apply"]);
export const JevConfig = z.object({
  enabled: z.boolean().default(false),
  model: z.enum(["typesafe/jev-1.13", "~typesafe/jev-latest"]).default("typesafe/jev-1.13"),
  triage: DecisionMode.default("observe"),
  verification: DecisionMode.default("observe"),
  ranking: z.boolean().default(true),
  minConfidence: z.number().min(0).max(1).default(0.85),
  minProbability: z.number().min(0.5).max(1).default(0.95),
  dailyCalls: z.number().int().min(1).max(10000).default(100),
  timeoutMs: z.number().int().min(500).max(30000).default(8000),
  maxStateChars: z.number().int().min(1000).max(40000).default(20000),
  cacheMinutes: z.number().int().min(0).max(1440).default(60),
  weights: z.object({
    role: z.number().min(0).max(10).default(4),
    skills: z.number().min(0).max(10).default(4),
    seniority: z.number().min(0).max(10).default(2),
  }).prefault({}).refine(w => w.role + w.skills + w.seniority > 0, "Give at least one ranking factor a weight above zero."),
});
export type JevConfig = z.infer<typeof JevConfig>;
export const DEFAULT_JEV = JevConfig.parse({});

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type DecisionQuestions = Record<string, DecisionQuestion>;
export type DecisionAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, string> }
  | { type: "noul"; noul: number };
export type DecisionResult = {
  model: string;
  answers: Record<string, DecisionAnswer>;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  latencyMs: number;
};
export type DecisionRecipe = "triage" | "ranking" | "evaluation_check" | "materials_check" | "connection_test";
export type DecisionSummary = {
  route: string;
  score: number | null;
  confidence: number | null;
  probability: number | null;
  accepted: boolean;
};
export type DecisionRecord = {
  id: string;
  recipe: DecisionRecipe;
  positionId: string | null;
  mode: string;
  status: string;
  model: string;
  result: DecisionResult | null;
  summary: DecisionSummary | null;
  error: string | null;
  feedback: "agree" | "disagree" | null;
  createdAt: string;
  cached?: boolean;
};
