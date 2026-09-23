/**
 * Model benchmark for every LLM operation job-scout runs through an OpenAI-compatible gateway.
 *
 *   DATABASE_URL=... OPENAI_BASE_URL=... OPENAI_API_KEY=... \
 *     pnpm bench:models <triage|heavy|judge|chat|report> [--models a,b] [--ops evaluate,jd_review] \
 *                       [--judges x,y] [--concurrency N]
 *
 * Uses the real prompt builders and client, reads the DB (positions, profile) read-only and
 * writes nothing to job-scout tables: no llm_runs, no evaluations, no jobs. Results land in
 * $BENCH_OUT (default .data/bench). `report` prints the markdown tables.
 *
 * - triage: N models x a fixed set of positions with known answers (applied => pass, archived
 *   with a clear DQ => fail). Measures schema validity, agreement, latency, tokens.
 * - heavy:  evaluate / jd_review / company_research / materials on two positions. Measures
 *   first-pass schema compliance (production retries mask it), latency, tokens, length.
 * - judge:  blind rubric grading of the heavy outputs by several models (labels A.., not names).
 * - chat:   tool-selection cases against the desk-agent tool surface + a second turn with a
 *           fake tool result.
 *
 * Supply private cases via --cases /path/outside/checkout/cases.json (or BENCH_CASES).
 * Keep case files and recorded runs outside the public checkout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as llm from "@job-scout/llm";
import * as core from "@job-scout/core";
import * as shared from "@job-scout/shared";

const OUT = process.env.BENCH_OUT || ".data/bench";
mkdirSync(OUT, { recursive: true });

if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) {
  console.error("set OPENAI_BASE_URL and OPENAI_API_KEY (and DATABASE_URL)");
  process.exit(2);
}
const client = llm.createLlmClient({
  baseUrl: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY,
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 420_000),
});

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const modelsArg = opt("models")?.split(",").filter(Boolean);

// ---- candidate sets ---------------------------------------------------------
const TRIAGE_MODELS = modelsArg ?? [
  "gemini-3.1-flash-lite", // baseline (ran the bulk today)
  "gemini-3.8-flash-high", // user's current pick
  "gpt-5.4-mini",
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5",
  "grok-4.3",
  "grok-4.6",
  "gpt-5.6-sol",
];
const HEAVY_MODELS = modelsArg ?? ["grok-4.6", "gpt-5.6-sol", "claude-opus-5", "claude-sonnet-5", "gemini-3.1-pro-low", "gemini-3.8-flash-high"];
const CHAT_MODELS = modelsArg ?? ["gemini-3.8-flash-high", "grok-4.6", "gpt-5.6-sol", "claude-sonnet-5", "gpt-5.4-mini", "gemini-3.1-flash-lite"];

// Case labels and pipeline identifiers are private runtime input, never source fixtures.
const Cases = z.object({
  triage: z.array(z.object({ slug: z.string().min(1), expect: z.enum(["pass", "fail", "either"]), why: z.string() })).default([]),
  heavy: z.array(z.string().min(1)).default([]),
});
const casesPath = opt("cases") || process.env.BENCH_CASES;
const cases = casesPath ? Cases.parse(JSON.parse(readFileSync(casesPath, "utf8"))) : Cases.parse({});
if ((cmd === "triage" && !cases.triage.length) || (cmd === "heavy" && !cases.heavy.length)) {
  throw new Error("Provide private benchmark cases with --cases or BENCH_CASES; see docs/BENCHMARKS.md");
}
const TRIAGE_SET = cases.triage;
const HEAVY_POSITIONS = cases.heavy;

// ---- helpers ----------------------------------------------------------------
type Run = {
  op: string;
  model: string;
  subject: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  retried?: boolean;
  data?: unknown;
  markdown?: string;
  sections?: Record<string, string>;
  content?: string;
};

function save(name: string, v: unknown) {
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(v, null, 1));
}
function load<T>(name: string): T {
  return JSON.parse(readFileSync(`${OUT}/${name}.json`, "utf8"));
}
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}
const t0 = Date.now();
const log = (s: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${s}`);

/** Detect a chatDocument retry from the client: it doubles tokens and latency; we reproduce first-pass validity ourselves. */
async function docRun(op: string, model: string, subject: string, messages: llm.ChatMessage[], schema: z.ZodType, sections: string[] | undefined, temperature: number, maxTokens: number): Promise<Run> {
  const started = Date.now();
  // First pass only, to measure schema compliance without the retry masking it.
  const instructions = [
    "",
    "OUTPUT FORMAT (strict):",
    ...(sections?.length
      ? [`Write each section as markdown, each starting on its own line with the marker \`=== SECTION: <name> ===\` for these names in order: ${sections.join(", ")}.`]
      : ["Write the document as markdown."]),
    "After the document, output exactly one fenced ```json block containing ONE object that conforms to this JSON schema. Do not repeat the schema itself; no other text after the block:",
    JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" })),
  ].join("\n");
  const msgs = messages.map((m, idx) => (idx === 0 && m.role === "system" ? { ...m, content: `${m.content}\n${instructions}` } : m));
  try {
    const first = await client.chat({ model, messages: msgs, temperature, maxTokens });
    const split = llm.splitDocument(first.content, sections ?? []);
    const v = schema.safeParse(split.json);
    if (v.success) return { op, model, subject, ok: true, latencyMs: first.latencyMs, tokensIn: first.tokensIn, tokensOut: first.tokensOut, data: v.data, markdown: split.markdown, sections: split.sections };
    // emulate production retry
    const retry = await client.chat({
      model,
      temperature,
      maxTokens: Math.min(maxTokens, 2000),
      jsonSchema: { name: op, schema },
      messages: [...msgs, { role: "assistant", content: first.content.slice(0, 12_000) }, { role: "user", content: `The JSON block was missing or invalid (${v.error.message.slice(0, 800)}). Reply with ONLY the JSON object for the schema, summarizing the document above.` }],
    });
    const v2 = schema.safeParse(llm.parseJsonLenient(retry.content));
    return {
      op, model, subject,
      ok: v2.success,
      error: v2.success ? undefined : `schema fail after retry: ${v2.error.message.slice(0, 300)}`,
      retried: true,
      latencyMs: Date.now() - started,
      tokensIn: (first.tokensIn ?? 0) + (retry.tokensIn ?? 0),
      tokensOut: (first.tokensOut ?? 0) + (retry.tokensOut ?? 0),
      data: v2.success ? v2.data : undefined,
      markdown: split.markdown,
      sections: split.sections,
      content: v2.success ? undefined : first.content.slice(-1500),
    };
  } catch (e) {
    return { op, model, subject, ok: false, error: String((e as Error).message).slice(0, 400), latencyMs: Date.now() - started, tokensIn: null, tokensOut: null };
  }
}

// ---- triage -----------------------------------------------------------------
async function triage() {
  const settings = await core.getSettings();
  const profile = await core.getProfile();
  const brief = core.briefOf(profile);
  const inputs: Array<{ slug: string; messages: llm.ChatMessage[]; expect: string; why: string; prod: { score: number | null; verdict: string | null } }> = [];
  for (const t of TRIAGE_SET) {
    const pos = await core.getPosition(t.slug);
    if (!pos) throw new Error(`missing ${t.slug}`);
    const jdText = await core.currentJdText(pos.id);
    const ats = ((pos.metadata || {}) as { ats?: { workplaceType?: string | null } }).ats;
    inputs.push({
      slug: t.slug, expect: t.expect, why: t.why,
      prod: { score: pos.triageScore, verdict: pos.triageVerdict },
      messages: llm.buildTriageMessages({
        title: pos.title, company: pos.company.name,
        locationRaw: pos.geoNotes ? `${pos.remoteClass || ""} ${pos.geoNotes}` : pos.remoteClass,
        workplaceType: ats?.workplaceType ?? null, salaryRaw: pos.salaryRaw, employmentType: pos.employmentType,
        jdText, brief, jdMaxChars: settings.triage.jdMaxChars, passThreshold: settings.triage.passThreshold, marginalThreshold: settings.triage.marginalThreshold,
      }),
    });
  }
  type TR = Run & { expect: string; verdict?: string; score?: number; hardDq?: string[] };
  const runs: TR[] = modelsArg && existsSync(`${OUT}/triage.json`) ? load<{ runs: TR[] }>("triage").runs.filter((r) => !modelsArg.includes(r.model)) : [];
  const jobs = TRIAGE_MODELS.flatMap((model) => inputs.map((i) => ({ model, i })));
  await pool(jobs, Number(opt("concurrency") || 8), async ({ model, i }) => {
    const started = Date.now();
    try {
      const r = await client.chatJson({ model, messages: i.messages, schema: llm.TriageOutput, schemaName: "triage", temperature: 0.1, maxTokens: 900 });
      const score = Math.round(r.data.score * 10) / 10;
      const verdict = llm.verdictFor(score, r.data.hardDq, settings.triage);
      runs.push({ op: "triage", model, subject: i.slug, expect: i.expect, ok: true, latencyMs: r.latencyMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut, verdict, score, hardDq: r.data.hardDq, data: r.data });
      log(`triage ${model.padEnd(26)} ${i.slug.slice(0, 40).padEnd(40)} ${verdict.padEnd(8)} ${score} ${r.latencyMs}ms`);
    } catch (e) {
      runs.push({ op: "triage", model, subject: i.slug, expect: i.expect, ok: false, error: String((e as Error).message).slice(0, 300), latencyMs: Date.now() - started, tokensIn: null, tokensOut: null });
      log(`triage ${model} ${i.slug} ERROR ${(e as Error).message.slice(0, 120)}`);
    }
  });
  save("triage", { set: inputs.map(({ messages, ...rest }) => rest), runs });
}

// ---- heavy ops --------------------------------------------------------------
async function heavy() {
  const profile = await core.getProfile();
  const brief = core.briefOf(profile);
  const tasks: Array<() => Promise<Run>> = [];
  const only = opt("ops")?.split(",");
  for (const slug of HEAVY_POSITIONS) {
    const pos = await core.getPosition(slug);
    if (!pos) throw new Error(`missing ${slug}`);
    const jdText = await core.currentJdText(pos.id);
    const company = await core.getCompany(pos.companyId);
    const checklist = shared.buildAtsKeywordChecklist({ jdText, materialsText: profile.masterResumeMarkdown || "" });
    const atsKeywords = checklist.items.filter((i: { inJd: boolean }) => i.inJd).map((i: { term: string }) => i.term).slice(0, 40);
    const evalMsgs = llm.buildEvaluateMessages({
      title: pos.title, company: pos.company.name, companyOverview: pos.company.overview, url: pos.primaryUrl, locationRaw: pos.remoteClass, salaryRaw: pos.salaryRaw,
      jdText, identityMarkdown: profile.identityMarkdown || "", masterResumeMarkdown: profile.masterResumeMarkdown || "", brief, triageJson: pos.triageJson,
    });
    const jdMsgs = llm.buildJdReviewMessages({ title: pos.title, company: pos.company.name, jdText, masterResumeMarkdown: profile.masterResumeMarkdown || "", atsKeywords });
    const crMsgs = llm.buildCompanyResearchMessages({
      company: company!.name, website: company!.website, careersUrl: company!.careersUrl, knownOverview: company!.overview,
      openTitles: company!.positions.filter((p: { listingStatus: string | null }) => p.listingStatus !== "closed").map((p: { title: string }) => p.title), sampleJd: jdText,
    });
    const matMsgs = llm.buildMaterialsMessages({
      title: pos.title, company: pos.company.name, jdText, identityMarkdown: profile.identityMarkdown || "", masterResumeMarkdown: profile.masterResumeMarkdown || "",
      masterCoverMarkdown: profile.masterCoverMarkdown, resumeSurfaces: (profile.resumeSurfaces || {}) as Record<string, string>, preferredSurface: pos.resumeSurface, evaluationMarkdown: null, atsKeywords,
    });
    for (const model of HEAVY_MODELS) {
      if (!only || only.includes("evaluate")) tasks.push(() => docRun("evaluate", model, slug, evalMsgs, llm.EvaluateOutput, undefined, 0.3, 9000));
      if (!only || only.includes("jd_review")) tasks.push(() => docRun("jd_review", model, slug, jdMsgs, llm.JdReviewOutput, undefined, 0.2, 5000));
      if (!only || only.includes("company_research")) tasks.push(() => docRun("company_research", model, company!.slug, crMsgs, llm.CompanyResearchOutput, undefined, 0.3, 4000));
      if ((!only || only.includes("materials")) && slug === HEAVY_POSITIONS[0]) tasks.push(() => docRun("materials", model, slug, matMsgs, llm.MaterialsOutput, ["resume", "cover"], 0.4, 7000));
    }
  }
  const runs: Run[] = modelsArg && existsSync(`${OUT}/heavy.json`) ? load<{ runs: Run[] }>("heavy").runs.filter((r) => !modelsArg.includes(r.model)) : [];
  await pool(tasks, Number(opt("concurrency") || 8), async (t) => {
    const r = await t();
    runs.push(r);
    log(`${r.op.padEnd(17)} ${r.model.padEnd(22)} ${r.subject.slice(0, 32).padEnd(32)} ${r.ok ? "ok " : "ERR"} ${r.retried ? "retry" : "     "} ${(r.latencyMs / 1000).toFixed(0).padStart(4)}s in=${r.tokensIn} out=${r.tokensOut} md=${r.markdown?.length ?? 0} ${r.error ?? ""}`);
    save("heavy", { runs });
  });
  save("heavy", { runs });
}

// ---- judge ------------------------------------------------------------------
const JUDGES = (opt("judges") ?? "claude-opus-5,gpt-5.6-sol,grok-4.6").split(",");
const RUBRICS: Record<string, string> = {
  evaluate: "Rubric: (1) grounded — quotes/refers to actual JD requirements, no invented facts; (2) honest — names real gaps, no flattery; (3) Brazil/remote eligibility read is correct and explicit; (4) follows the A-H structure with a real must-haves table; (5) actionable — resume angle and questions are specific to this JD; (6) JSON summary is consistent with the document.",
  jd_review: "Rubric: (1) matches/gaps are specific to the JD and the resume, not generic; (2) keywordsToAdd are terms that actually appear in the JD and are missing from the resume; (3) seniority read is justified; (4) concise, no padding; (5) JSON consistent with document.",
  company_research: "Rubric: (1) does not hallucinate funding/headcount — marks unknown when the prompt gives no source; (2) risks and talking points are specific to this company and to a platform/SRE candidate; (3) remote policy read is careful; (4) concise; (5) JSON consistent with document.",
  materials: "Rubric: (1) resume uses only facts from the master resume (no invented employers/metrics); (2) tailors to JD keywords naturally, not stuffed; (3) cover letter is specific, short, and human; (4) respects the section markers; (5) keywordsCovered/Missing are truthful vs the JD.",
};

async function judge() {
  const { runs } = load<{ runs: Run[] }>("heavy");
  const groups = new Map<string, Run[]>();
  for (const r of runs) if (r.ok) groups.set(`${r.op}|${r.subject}`, [...(groups.get(`${r.op}|${r.subject}`) ?? []), r]);
  const Score = z.object({ scores: z.array(z.object({ label: z.string(), score: z.number().min(1).max(10), note: z.string() })), best: z.string(), worst: z.string() });
  type JR = { op: string; subject: string; judge: string; scores: Array<{ model: string; score: number; note: string }>; best: string; worst: string };
  const results: JR[] = existsSync(`${OUT}/judge.json`) ? load<{ results: JR[] }>("judge").results.filter((r) => !JUDGES.includes(r.judge)) : [];
  const tasks: Array<() => Promise<void>> = [];
  for (const [key, rs] of groups) {
    const [op, subject] = key.split("|") as [string, string];
    const labels = rs.map((_, i) => String.fromCharCode(65 + i));
    const docs = rs.map((r, i) => `### Candidate ${labels[i]}\n\n${(r.markdown ?? "").slice(0, 14_000)}\n\n\`\`\`json\n${JSON.stringify(r.data)}\n\`\`\``).join("\n\n---\n\n");
    for (const j of JUDGES) {
      tasks.push(async () => {
        try {
          const sys = `You are grading ${rs.length} anonymous AI outputs for the operation "${op}" in a job-hunt tool. Score each candidate 1-10 on the rubric. Be harsh, be specific, one-sentence note each. Return the label letters exactly.\n${RUBRICS[op] ?? ""}`;
          // Claude through an OpenAI-compatible gateway ignores response_format: ask for bare JSON and parse leniently.
          const r = j.startsWith("claude")
            ? await (async () => {
                const raw = await client.chat({ model: j, temperature: 0, maxTokens: 2500, messages: [{ role: "system", content: `${sys}\nReply with ONLY a JSON object: {"scores":[{"label":"A","score":7,"note":"..."}],"best":"A","worst":"B"}. No prose, no code fence.` }, { role: "user", content: docs }] });
                const v = Score.safeParse(llm.parseJsonLenient(raw.content));
                if (!v.success) throw new Error(`judge schema: ${v.error.message.slice(0, 200)} :: ${raw.content.slice(0, 200)}`);
                return { ...raw, data: v.data };
              })()
            : await client.chatJson({ model: j, schema: Score, schemaName: "judge", temperature: 0, maxTokens: 2500, messages: [{ role: "system", content: sys }, { role: "user", content: docs }] });
          const scores = r.data.scores.map((s) => ({ model: rs[labels.indexOf(s.label.trim().toUpperCase()[0]!)]?.model ?? s.label, score: s.score, note: s.note }));
          const pick = (l: string) => rs[labels.indexOf(l.trim().toUpperCase()[0]!)]?.model ?? l;
          results.push({ op, subject, judge: j, scores, best: pick(r.data.best), worst: pick(r.data.worst) });
          log(`judge ${j.padEnd(14)} ${op.padEnd(17)} ${subject.slice(0, 30).padEnd(30)} ${scores.map((s) => `${s.model}=${s.score}`).join(" ")}`);
        } catch (e) {
          log(`judge ${j} ${key} ERROR ${(e as Error).message.slice(0, 200)}`);
        }
        save("judge", { results });
      });
    }
  }
  await pool(tasks, 6, (t) => t());
  save("judge", { results });
}

// ---- chat (tool calling) ----------------------------------------------------
const CHAT_TOOLS: llm.ToolSpec[] = [
  { name: "search_positions", description: "Search the pipeline. Returns slim rows (slug, title, company, status, triage score/verdict).", parameters: { type: "object", properties: { q: { type: "string" }, status: { type: "string" }, company: { type: "string" }, minScore: { type: "number" }, limit: { type: "integer" } } } },
  { name: "get_position", description: "Full position detail incl. JD text, triage json, timeline, evaluation summary.", parameters: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] } },
  { name: "today", description: "Today dashboard: decisions due, approvals, changed listings, interviews, follow-ups.", parameters: { type: "object", properties: {} } },
  { name: "set_status", description: "Change a position's pipeline status.", parameters: { type: "object", properties: { slug: { type: "string" }, status: { type: "string" }, note: { type: "string" } }, required: ["slug", "status"] } },
  { name: "queue_operation", description: "Queue an LLM operation (triage|evaluate|materials|company_research|jd_review) for a position.", parameters: { type: "object", properties: { slug: { type: "string" }, operation: { type: "string" } }, required: ["slug", "operation"] } },
  { name: "browser_navigate", description: "Navigate the job-scout Chromium to a URL.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_snapshot", description: "Accessibility snapshot of the current page.", parameters: { type: "object", properties: {} } },
];
const CHAT_SYS = "You are the job-scout desk agent: a sharp, terse career-ops partner for one operator running a senior SRE/platform job hunt. You have tools over the operator's own pipeline and the web. Ground every claim in tool results; when you don't know, look it up. Prefer one good tool call over guessing. Style: plain prose or tight bullets, no filler, cite slugs. Scores are 0–5.";

const CHAT_CASES: Array<{ name: string; user: string; expectTools: string[]; forbid?: string[] }> = [
  { name: "today", user: "what's on my plate today?", expectTools: ["today"] },
  { name: "lookup", user: "is the Acme platform listing still open and what did we score it?", expectTools: ["get_position", "search_positions"] },
  { name: "browser", user: "open https://careers.example.com and tell me how many SRE roles are listed right now", expectTools: ["browser_navigate"] },
  { name: "write", user: "mark acme-platform-engineer as interview, I got the recruiter screen invite", expectTools: ["set_status"] },
  { name: "no_tool", user: "in one line, what's the difference between an SLO and an SLA?", expectTools: [], forbid: ["today", "search_positions", "get_position", "set_status", "queue_operation", "browser_navigate", "browser_snapshot"] },
];

async function chat() {
  type CR = { model: string; case: string; ok: boolean; pass: boolean; tools: string[]; content: string; latencyMs: number; ttfbMs: number | null; tokensIn: number | null; tokensOut: number | null; error?: string; secondTurnOk?: boolean; secondTurnMs?: number; secondTurnContent?: string };
  const runs: CR[] = modelsArg && existsSync(`${OUT}/chat.json`) ? load<{ runs: CR[] }>("chat").runs.filter((r) => !modelsArg.includes(r.model)) : [];
  const jobs = CHAT_MODELS.flatMap((model) => CHAT_CASES.map((c) => ({ model, c })));
  await pool(jobs, Number(opt("concurrency") || 6), async ({ model, c }) => {
    const started = Date.now();
    let ttfb: number | null = null;
    try {
      const r = await client.chatStream({ model, messages: [{ role: "system", content: CHAT_SYS }, { role: "user", content: c.user }], tools: CHAT_TOOLS, temperature: 0.2, maxTokens: 800, onDelta: () => { if (ttfb == null) ttfb = Date.now() - started; } });
      const tools = r.toolCalls.map((t) => t.name);
      const pass = c.expectTools.length ? tools.some((t) => c.expectTools.includes(t)) : tools.length === 0 && r.content.trim().length > 0;
      const forbidden = c.forbid?.some((f) => tools.includes(f)) ?? false;
      const row = { model, case: c.name, ok: true, pass: pass && !forbidden, tools, content: r.content.slice(0, 400), latencyMs: r.latencyMs, ttfbMs: ttfb, tokensIn: r.tokensIn, tokensOut: r.tokensOut } as (typeof runs)[number];
      // second turn: feed a fake tool result and see if the model answers well (for the lookup case)
      if (c.name === "lookup" && r.toolCalls.length) {
        const tc = r.toolCalls[0]!;
        const fake = tc.name === "today" ? { decisions: [] } : { total: 1, items: [{ slug: "acme-platform-engineer", title: "Platform Engineer", company: "Acme", status: "applied", listingStatus: "open", triageScore: 4.6, triageVerdict: "pass", evaluation: { score: 4.3, verdict: "apply" } }] };
        const s2 = Date.now();
        const r2 = await client.chatStream({
          model, tools: CHAT_TOOLS, temperature: 0.2, maxTokens: 500,
          messages: [
            { role: "system", content: CHAT_SYS }, { role: "user", content: c.user },
            { role: "assistant", content: r.content || null, tool_calls: r.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) },
            ...r.toolCalls.map((t) => ({ role: "tool" as const, tool_call_id: t.id, content: JSON.stringify(fake) })),
          ],
        });
        row.secondTurnOk = /open/i.test(r2.content) && /4\.6|4\.3/.test(r2.content);
        row.secondTurnMs = r2.latencyMs;
        row.secondTurnContent = r2.content.slice(0, 300);
      }
      runs.push(row);
      log(`chat ${model.padEnd(22)} ${c.name.padEnd(8)} ${row.pass ? "PASS" : "FAIL"} tools=[${tools.join(",")}] ${r.latencyMs}ms ttfb=${ttfb}ms ${row.secondTurnOk === undefined ? "" : `turn2=${row.secondTurnOk ? "ok" : "weak"}`}`);
    } catch (e) {
      runs.push({ model, case: c.name, ok: false, pass: false, tools: [], content: "", latencyMs: Date.now() - started, ttfbMs: ttfb, tokensIn: null, tokensOut: null, error: String((e as Error).message).slice(0, 300) });
      log(`chat ${model} ${c.name} ERROR ${(e as Error).message.slice(0, 160)}`);
    }
  });
  save("chat", { runs });
}

// ---- report -----------------------------------------------------------------
function pct(n: number, d: number) { return d ? `${Math.round((100 * n) / d)}%` : "-"; }
function med(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; }

function report() {
  const out: string[] = [];
  if (existsSync(`${OUT}/triage.json`)) {
    const { runs } = load<{ runs: Array<Run & { expect: string; verdict?: string; score?: number }> }>("triage");
    out.push("## Triage (private configured cases)");
    out.push("| model | ok | agree | false-neg | false-pos | median ms | tokens/call |");
    out.push("|---|---|---|---|---|---|---|");
    for (const m of TRIAGE_MODELS) {
      const rs = runs.filter((r) => r.model === m);
      const ok = rs.filter((r) => r.ok);
      const graded = ok.filter((r) => r.expect !== "either");
      const agree = graded.filter((r) => (r.expect === "pass" ? r.verdict !== "fail" : r.verdict === "fail"));
      const fn = graded.filter((r) => r.expect === "pass" && r.verdict === "fail").length;
      const fp = graded.filter((r) => r.expect === "fail" && r.verdict !== "fail").length;
      const tok = ok.length ? Math.round(ok.reduce((n, r) => n + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0) / ok.length) : 0;
      out.push(`| ${m} | ${ok.length}/${rs.length} | ${agree.length}/${graded.length} | ${fn} | ${fp} | ${med(ok.map((r) => r.latencyMs))} | ${tok} |`);
    }
    out.push("");
    out.push("Per-position verdicts (score):");
    const subjects = [...new Set(runs.map((r) => r.subject))];
    out.push(`| position | expect | ${TRIAGE_MODELS.join(" | ")} |`);
    out.push(`|---|---|${TRIAGE_MODELS.map(() => "---").join("|")}|`);
    for (const s of subjects) {
      const cells = TRIAGE_MODELS.map((m) => { const r = runs.find((x) => x.model === m && x.subject === s); return r?.ok ? `${r.verdict} ${r.score}` : "ERR"; });
      out.push(`| ${s.slice(0, 44)} | ${runs.find((r) => r.subject === s)?.expect} | ${cells.join(" | ")} |`);
    }
    out.push("");
  }
  if (existsSync(`${OUT}/heavy.json`)) {
    const { runs } = load<{ runs: Run[] }>("heavy");
    const judged = existsSync(`${OUT}/judge.json`) ? load<{ results: Array<{ op: string; subject: string; judge: string; scores: Array<{ model: string; score: number; note: string }> }> }>("judge").results : [];
    for (const op of ["evaluate", "jd_review", "company_research", "materials"]) {
      const rs = runs.filter((r) => r.op === op);
      if (!rs.length) continue;
      out.push(`## ${op}`);
      out.push("| model | ok | 1st-pass schema | median s | tokens in/out | md chars | judge avg (n) |");
      out.push("|---|---|---|---|---|---|---|");
      for (const m of HEAVY_MODELS) {
        const mr = rs.filter((r) => r.model === m);
        const ok = mr.filter((r) => r.ok);
        const first = ok.filter((r) => !r.retried);
        const js = judged.filter((j) => j.op === op).flatMap((j) => j.scores.filter((s) => s.model === m).map((s) => s.score));
        const avg = js.length ? (js.reduce((a, b) => a + b, 0) / js.length).toFixed(1) : "-";
        out.push(`| ${m} | ${ok.length}/${mr.length} | ${first.length}/${mr.length} | ${(med(ok.map((r) => r.latencyMs)) / 1000).toFixed(0)} | ${Math.round(ok.reduce((n, r) => n + (r.tokensIn ?? 0), 0) / (ok.length || 1))}/${Math.round(ok.reduce((n, r) => n + (r.tokensOut ?? 0), 0) / (ok.length || 1))} | ${Math.round(ok.reduce((n, r) => n + (r.markdown?.length ?? 0), 0) / (ok.length || 1))} | ${avg} (${js.length}) |`);
      }
      const errs = rs.filter((r) => !r.ok);
      if (errs.length) out.push("", ...errs.map((e) => `- ERR ${e.model} ${e.subject}: ${e.error}`));
      out.push("");
    }
    if (judged.length) {
      out.push("## Judge notes (best/worst per op)");
      for (const j of judged) out.push(`- ${j.op} · ${j.subject.slice(0, 28)} · judge=${j.judge}: ` + j.scores.map((s) => `${s.model}=${s.score}`).join(", "));
      out.push("");
    }
  }
  if (existsSync(`${OUT}/chat.json`)) {
    const { runs } = load<{ runs: Array<{ model: string; case: string; ok: boolean; pass: boolean; tools: string[]; latencyMs: number; ttfbMs: number | null; secondTurnOk?: boolean; secondTurnMs?: number; error?: string }> }>("chat");
    out.push("## Chat (tool selection)");
    out.push(`| model | pass | ${CHAT_CASES.map((c) => c.name).join(" | ")} | turn2 | median ms | median ttfb |`);
    out.push(`|---|---|${CHAT_CASES.map(() => "---").join("|")}|---|---|---|`);
    for (const m of CHAT_MODELS) {
      const rs = runs.filter((r) => r.model === m);
      const cells = CHAT_CASES.map((c) => { const r = rs.find((x) => x.case === c.name); return !r ? "-" : !r.ok ? "ERR" : `${r.pass ? "✓" : "✗"} [${r.tools.join(",")}]`; });
      const t2 = rs.find((r) => r.secondTurnOk !== undefined);
      out.push(`| ${m} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${cells.join(" | ")} | ${t2 ? (t2.secondTurnOk ? `ok ${t2.secondTurnMs}ms` : `weak ${t2.secondTurnMs}ms`) : "-"} | ${med(rs.filter((r) => r.ok).map((r) => r.latencyMs))} | ${med(rs.filter((r) => r.ttfbMs != null).map((r) => r.ttfbMs!))} |`);
    }
    const errs = runs.filter((r) => !r.ok);
    if (errs.length) out.push("", ...errs.map((e) => `- ERR ${e.model} ${e.case}: ${e.error}`));
  }
  const txt = out.join("\n");
  writeFileSync(`${OUT}/REPORT.md`, txt);
  console.log(txt);
}

const cmds: Record<string, () => Promise<void> | void> = { triage, heavy, judge, chat, report };
if (!cmd || !cmds[cmd]) {
  console.error(`usage: bench-models.ts <${Object.keys(cmds).join("|")}> [--models a,b] [--ops ..] [--judges ..] [--concurrency N]`);
  process.exit(2);
}
await cmds[cmd]!();
process.exit(0);
