import { z } from "zod";
import type { DecisionQuestions, DecisionResult } from "@job-scout/shared";

const probability = z.number().min(0).max(1);
const distribution = z.record(z.string(), probability);
const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: distribution }),
  z.object({ type: z.literal("score"), score: z.number().nonnegative(), confidence: probability, probabilities: distribution, legend: z.record(z.string(), z.string()).optional() }),
]);
const Response = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().default(0), cost: z.number().nonnegative().nullable().optional() }),
});

export class DecisionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "DecisionError"; }
}

export function parseDecisionResponse(raw: unknown, questions: DecisionQuestions): Omit<DecisionResult, "latencyMs"> {
  const parsed = Response.safeParse(raw);
  if (!parsed.success) throw new DecisionError("invalid_response", "Jev returned an invalid response.");
  const { answers, usage, model } = parsed.data;
  if (Object.keys(answers).length !== Object.keys(questions).length) throw new DecisionError("invalid_response", "Jev returned a different set of answers.");
  for (const [key, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, key) ? answers[key] : undefined;
    if (!answer || answer.type !== question.type) throw new DecisionError("invalid_response", "Jev omitted an answer or changed its type.");
    if (answer.type === "noul" || question.type === "noul") continue;
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    const values = answer.probabilities;
    if (Object.keys(values).length !== keys.length || keys.some(k => !(k in values)) || Math.abs(Object.values(values).reduce((a, b) => a + b, 0) - 1) > 0.025)
      throw new DecisionError("invalid_response", "Jev returned an invalid probability distribution.");
    if (answer.type === "choice" && (!keys.includes(answer.choice) || values[answer.choice] < Math.max(...Object.values(values)) - 0.015))
      throw new DecisionError("invalid_response", "Jev returned a choice outside the expected options.");
    if (answer.type === "score" && (answer.score > keys.length - 1 || Math.abs(answer.score - keys.reduce((sum, k) => sum + Number(k) * values[k], 0)) > 0.05))
      throw new DecisionError("invalid_response", "Jev returned a score outside the expected scale.");
  }
  return { model, answers, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cost: usage.cost ?? null };
}

export async function requestDecision(input: {
  apiKey: string; model: string; state: unknown; questions: DecisionQuestions; timeoutMs: number;
}, fetcher: typeof fetch = fetch): Promise<DecisionResult> {
  if (!input.apiKey) throw new DecisionError("not_configured", "Set OPENROUTER_API_KEY on the server to connect Jev.");
  const started = Date.now();
  const signal = AbortSignal.timeout(input.timeoutMs);
  try {
    const response = await fetcher("https://openrouter.ai/api/alpha/decisions", {
      method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json", "X-OpenRouter-Title": "Job Scout" },
      body: JSON.stringify({ model: input.model, state: input.state, questions: input.questions }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const message = response.status === 401 ? "OpenRouter rejected the API key." : response.status === 402 ? "OpenRouter needs credits for this request." : response.status === 429 ? "OpenRouter is rate limiting requests. Try again later." : `OpenRouter could not complete the request (HTTP ${response.status}).`;
      throw new DecisionError(`http_${response.status}`, message);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DecisionError("invalid_response", "OpenRouter returned an empty response.");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 256_000) throw new DecisionError("invalid_response", "OpenRouter returned too much data.");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { ...parseDecisionResponse(raw, input.questions), latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof DecisionError) throw error;
    if (signal.aborted) throw new DecisionError("timeout", "Jev did not respond before the time limit.");
    throw new DecisionError("connection", "Could not read a valid response from OpenRouter.");
  }
}
