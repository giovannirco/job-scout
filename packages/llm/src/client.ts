import { z } from "zod";

/**
 * Minimal OpenAI-compatible chat client for an OpenAI-compatible gateway (or any /v1 gateway).
 * No SDK: fetch + bearer. Structured output via response_format json_schema
 * with graceful fallback to json_object + lenient parse.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  model: string;
  /** If the primary model hits a provider quota/limit, retry once on this model */
  fallbackModel?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** When set, ask for structured JSON matching this zod schema */
  jsonSchema?: { name: string; schema: z.ZodType };
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ChatResult = {
  content: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  finishReason: string | null;
  raw: unknown;
};

export type ModelInfo = { id: string; ownedBy?: string; created?: number };

export class LlmError extends Error {
  status: number | null;
  body: string | null;
  constructor(message: string, status: number | null = null, body: string | null = null) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
  }
}

const QUOTA_RE =
  /insufficient_quota|quota[_ ]exceeded|exceeded your (current )?quota|usage[_ ]limit|out of credits|credit limit|plan limit|rate[_ ]limit|billing hard limit/;

/** Provider quota / plan / rate-limit — not our dailyCap. */
export function isQuotaLimitError(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;
  if (err.status === 429 || err.status === 402) return true;
  const blob = `${err.message}\n${err.body ?? ""}`.toLowerCase();
  return QUOTA_RE.test(blob);
}

async function withQuotaFallback<T>(model: string, fallbackModel: string | undefined, run: (model: string) => Promise<T>): Promise<T> {
  try {
    return await run(model);
  } catch (e) {
    if (!fallbackModel || fallbackModel === model || !isQuotaLimitError(e)) throw e;
    return run(fallbackModel);
  }
}

export type LlmClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** Default request timeout */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function createLlmClient(opts: LlmClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const defaultTimeout = opts.timeoutMs ?? 120_000;

  function requestSignal(outer: AbortSignal | null | undefined, timeoutMs: number) {
    outer?.throwIfAborted();
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(outer?.reason);
    outer?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error(`llm timeout after ${timeoutMs}ms`)), timeoutMs);
    return { signal: ctrl.signal, dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", abort);
    } };
  }

  function headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    };
  }

  async function request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const lifetime = requestSignal(init.signal, timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, { ...init, headers: { ...headers(), ...(init.headers as object) }, signal: lifetime.signal });
      const text = await res.text();
      if (!res.ok) {
        throw new LlmError(`llm ${res.status} on ${path}: ${text.slice(0, 500)}`, res.status, text);
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new LlmError(`llm returned non-JSON on ${path}: ${text.slice(0, 300)}`, res.status, text);
      }
    } finally {
      lifetime.dispose();
    }
  }

  async function listModels(): Promise<ModelInfo[]> {
    const json = await request<{ data?: Array<{ id: string; owned_by?: string; created?: number }> }>(
      "/models",
      { method: "GET" },
      20_000,
    );
    return (json.data || [])
      .filter((m) => typeof m.id === "string")
      .map((m) => ({ id: m.id, ownedBy: m.owned_by, created: m.created }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async function chat(o: ChatOptions): Promise<ChatResult> {
    const t0 = Date.now();
    const run = async (model: string): Promise<ChatResult> => {
      const body: Record<string, unknown> = {
        model,
        messages: o.messages,
        stream: false,
      };
      if (o.temperature != null) body.temperature = o.temperature;
      if (o.maxTokens != null) body.max_tokens = o.maxTokens;
      if (o.jsonSchema) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: o.jsonSchema.name,
            strict: false,
            schema: z.toJSONSchema(o.jsonSchema.schema, { target: "draft-7" }),
          },
        };
      }
      let json: OpenAiChatResponse;
      try {
        json = await request<OpenAiChatResponse>(
          "/chat/completions",
          { method: "POST", body: JSON.stringify(body), signal: o.signal },
          o.timeoutMs ?? defaultTimeout,
        );
      } catch (e) {
        if (o.jsonSchema && e instanceof LlmError && e.status === 400) {
          body.response_format = { type: "json_object" };
          json = await request<OpenAiChatResponse>(
            "/chat/completions",
            { method: "POST", body: JSON.stringify(body), signal: o.signal },
            o.timeoutMs ?? defaultTimeout,
          );
        } else {
          throw e;
        }
      }
      const choice = json.choices?.[0];
      const content = extractContent(choice?.message?.content);
      if (!content.trim()) throw new LlmError("llm returned an empty completion", null, JSON.stringify(json));
      return {
        content,
        model: json.model || model,
        tokensIn: json.usage?.prompt_tokens ?? null,
        tokensOut: json.usage?.completion_tokens ?? null,
        latencyMs: Date.now() - t0,
        finishReason: choice?.finish_reason ?? null,
        raw: json,
      };
    };
    return withQuotaFallback(o.model, o.fallbackModel, run);
  }

  /** chat + parse + validate. Retries once with the validation error appended. */
  async function chatJson<T>(o: ChatOptions & { schema: z.ZodType<T>; schemaName: string }): Promise<ChatResult & { data: T }> {
    // Inline the schema too: some upstreams behind the gateway (Claude OAuth) drop
    // response_format, and without field names they answer in prose.
    const hint = `\nReply with ONLY one JSON object (no prose, no code fence) matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(o.schema, { target: "draft-7" }))}`;
    const messages: ChatMessage[] = o.messages.map((m, idx) => (idx === 0 && m.role === "system" ? { ...m, content: m.content + hint } : m));
    if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: hint.trim() });
    o = { ...o, messages };
    const first = await chat({ ...o, jsonSchema: { name: o.schemaName, schema: o.schema } });
    const parsed = parseJsonLenient(first.content);
    const v1 = o.schema.safeParse(parsed);
    if (v1.success) return { ...first, data: v1.data };
    const retry = await chat({
      ...o,
      model: first.model || o.model,
      fallbackModel: first.model && first.model !== o.model ? undefined : o.fallbackModel,
      jsonSchema: { name: o.schemaName, schema: o.schema },
      messages: [
        ...o.messages,
        { role: "assistant", content: first.content.slice(0, 4000) },
        {
          role: "user",
          content: `Your previous answer was not valid for the required JSON schema: ${v1.error.message.slice(0, 1500)}. Reply with ONLY the corrected JSON object.`,
        },
      ],
    });
    const v2 = o.schema.safeParse(parseJsonLenient(retry.content));
    if (!v2.success) {
      throw new LlmError(`llm output failed schema ${o.schemaName}: ${v2.error.message.slice(0, 800)}`, null, retry.content);
    }
    return {
      ...retry,
      tokensIn: (first.tokensIn ?? 0) + (retry.tokensIn ?? 0),
      tokensOut: (first.tokensOut ?? 0) + (retry.tokensOut ?? 0),
      latencyMs: first.latencyMs + retry.latencyMs,
      data: v2.data,
    };
  }

  /**
   * Long-form output: the model writes free markdown (optionally split into named
   * sections) and finishes with ONE fenced ```json block validated by `schema`.
   * Much more robust than asking for a 3k-word document inside a JSON string.
   */
  async function chatDocument<T>(
    o: ChatOptions & { schema: z.ZodType<T>; schemaName: string; sections?: string[] },
  ): Promise<ChatResult & { data: T; markdown: string; sections: Record<string, string> }> {
    const sectionNames = o.sections ?? [];
    const instructions = [
      "",
      "OUTPUT FORMAT (strict):",
      ...(sectionNames.length
        ? [
            `Write each section as markdown, each starting on its own line with the marker \`=== SECTION: <name> ===\` for these names in order: ${sectionNames.join(", ")}.`,
          ]
        : ["Write the document as markdown."]),
      "After the document, output exactly one fenced ```json block containing ONE object that conforms to this JSON schema. Do not repeat the schema itself; no other text after the block:",
      JSON.stringify(z.toJSONSchema(o.schema, { target: "draft-7" })),
    ].join("\n");
    const messages: ChatMessage[] = o.messages.map((m, idx) =>
      idx === 0 && m.role === "system" ? { ...m, content: `${m.content}\n${instructions}` } : m,
    );
    if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: instructions });

    const first = await chat({ ...o, messages, jsonSchema: undefined });
    let split = splitDocument(first.content, sectionNames);
    let v = o.schema.safeParse(split.json);
    if (v.success) return { ...first, data: v.data, markdown: split.markdown, sections: split.sections };

    const retry = await chat({
      ...o,
      model: first.model || o.model,
      fallbackModel: first.model && first.model !== o.model ? undefined : o.fallbackModel,
      jsonSchema: { name: o.schemaName, schema: o.schema },
      maxTokens: Math.min(o.maxTokens ?? 2000, 2000),
      messages: [
        ...messages,
        { role: "assistant", content: first.content.slice(0, 12_000) },
        {
          role: "user",
          content: `The JSON block was missing or invalid (${v.error.message.slice(0, 800)}). Reply with ONLY the JSON object for the schema, summarizing the document above.`,
        },
      ],
    });
    v = o.schema.safeParse(parseJsonLenient(retry.content));
    if (!v.success) throw new LlmError(`llm output failed schema ${o.schemaName}: ${v.error.message.slice(0, 800)}`, null, retry.content);
    split = splitDocument(first.content, sectionNames);
    return {
      ...first,
      tokensIn: (first.tokensIn ?? 0) + (retry.tokensIn ?? 0),
      tokensOut: (first.tokensOut ?? 0) + (retry.tokensOut ?? 0),
      latencyMs: first.latencyMs + retry.latencyMs,
      data: v.data,
      markdown: split.markdown,
      sections: split.sections,
    };
  }

  /**
   * Streaming chat with OpenAI-style tool calling. Emits content deltas as they
   * arrive; tool-call argument fragments are assembled and returned whole.
   */
  async function chatStream(o: AgentChatOptions): Promise<AgentChatResult> {
    const t0 = Date.now();
    const run = async (modelName: string): Promise<AgentChatResult> => {
    const body: Record<string, unknown> = {
      model: modelName,
      messages: o.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (o.temperature != null) body.temperature = o.temperature;
    if (o.maxTokens != null) body.max_tokens = o.maxTokens;
    if (o.tools?.length) {
      body.tools = o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = "auto";
    }
    const timeoutMs = o.timeoutMs ?? defaultTimeout;
    const lifetime = requestSignal(o.signal, timeoutMs);
    try {
      const res = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { ...headers(), Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: lifetime.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new LlmError(`llm ${res.status} on /chat/completions: ${text.slice(0, 500)}`, res.status, text);
      }
      let content = "";
      let model = modelName;
      let finishReason: string | null = null;
      let tokensIn: number | null = null;
      let tokensOut: number | null = null;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handle = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let json: StreamChunk;
        try {
          json = JSON.parse(data) as StreamChunk;
        } catch {
          return;
        }
        if (json.model) model = json.model;
        if (json.usage) {
          tokensIn = json.usage.prompt_tokens ?? tokensIn;
          tokensOut = json.usage.completion_tokens ?? tokensOut;
        }
        const ch = json.choices?.[0];
        if (!ch) return;
        if (ch.finish_reason) finishReason = ch.finish_reason;
        const d = ch.delta || {};
        const piece = extractContent(d.content as string | Array<{ type?: string; text?: string }> | null | undefined);
        if (piece) {
          content += piece;
          o.onDelta?.(piece);
        }
        for (const tc of d.tool_calls || []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) || { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(idx, cur);
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          handle(line);
        }
      }
      if (buf.trim()) handle(buf.trim());
      if (!finishReason) throw new LlmError("llm stream ended without a finish reason");
      const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c], i) => ({
          id: c.id || `call_${i}`,
          name: c.name,
          arguments: c.args,
          args: safeParseArgs(c.args),
        }));
      return { content, toolCalls, model, finishReason, tokensIn, tokensOut, latencyMs: Date.now() - t0 };
    } finally {
      lifetime.dispose();
    }
    };
    return withQuotaFallback(o.model, o.fallbackModel, run);
  }

  return { listModels, chat, chatJson, chatDocument, chatStream, baseUrl: base };
}

/** Messages for the tool-calling agent loop (superset of ChatMessage). */
export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type AgentChatOptions = {
  model: string;
  fallbackModel?: string;
  messages: AgentMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onDelta?: (text: string) => void;
};

export type AgentToolCall = { id: string; name: string; arguments: string; args: Record<string, unknown> };

export type AgentChatResult = {
  content: string;
  toolCalls: AgentToolCall[];
  model: string;
  finishReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
};

type StreamChunk = {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
};

function safeParseArgs(s: string): Record<string, unknown> {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    const v = parseJsonLenient(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  }
}

export type LlmClient = ReturnType<typeof createLlmClient>;

type OpenAiChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

function extractContent(c: string | Array<{ type?: string; text?: string }> | null | undefined): string {
  if (!c) return "";
  if (typeof c === "string") return c;
  return c.map((p) => p.text || "").join("");
}

/** Split "markdown … ```json {…} ```" into the document, named sections and the parsed JSON tail. */
export function splitDocument(text: string, sectionNames: string[]): { markdown: string; sections: Record<string, string>; json: unknown } {
  const t = text.trim();
  // last fenced json block wins
  const fenceRe = /```json\s*([\s\S]*?)```\s*$/i;
  let json: unknown = null;
  let markdown = t;
  const m = t.match(fenceRe);
  if (m) {
    json = parseLastJsonValue(m[1]);
    markdown = t.slice(0, m.index).trim();
  } else {
    // maybe an unfenced trailing object
    const lastBrace = t.lastIndexOf("\n{");
    if (lastBrace > 0) {
      try {
        json = JSON.parse(t.slice(lastBrace + 1).trim());
        markdown = t.slice(0, lastBrace).trim();
      } catch {
        json = null;
      }
    }
  }
  const sections: Record<string, string> = {};
  if (sectionNames.length) {
    const re = /^=== SECTION:\s*([^=]+?)\s*===\s*$/gim;
    const marks: { name: string; start: number; end: number }[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(markdown))) marks.push({ name: mm[1].trim().toLowerCase(), start: mm.index, end: mm.index + mm[0].length });
    for (let i = 0; i < marks.length; i++) {
      const body = markdown.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].start : undefined).trim();
      sections[marks[i].name] = body;
    }
    if (marks.length) markdown = markdown.slice(0, marks[0].start).trim() || markdown;
  }
  return { markdown, sections, json };
}

/**
 * Parse a fenced block that may hold more than one top-level JSON value
 * (Claude tends to echo the schema first, then the object). The last value wins.
 */
export function parseLastJsonValue(block: string): unknown {
  const s = block.trim();
  try {
    return JSON.parse(s);
  } catch {
    /* continue */
  }
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^\s*[[{]/.test(lines[i]!)) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n").trim());
    } catch {
      /* keep walking back */
    }
  }
  return null;
}

/** Accepts raw JSON, fenced ```json blocks, or prose with one JSON object inside. */
export function parseJsonLenient(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* continue */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const v = parseLastJsonValue(fence[1]);
    if (v != null) return v;
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* continue */
    }
  }
  return null;
}
