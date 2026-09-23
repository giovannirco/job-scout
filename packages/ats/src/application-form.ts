export type QuestionPrompt = {
  question: string;
  required: boolean;
  inputType: string;
  options?: string[];
};

type GreenhouseField = { type?: string; values?: Array<{ label?: string }> };
type GreenhouseQuestion = { label?: string; description?: string; required?: boolean; fields?: GreenhouseField[] };

/** Greenhouse `?questions=true` includes required, field type, and select labels. */
export function greenhouseQuestionPrompts(questions: GreenhouseQuestion[]): QuestionPrompt[] {
  const seen = new Set<string>();
  const out: QuestionPrompt[] = [];
  for (const q of questions) {
    const question = normalizeQuestion(q.label || q.description || "");
    if (!question || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    const fields = q.fields || [];
    const types = fields.map((f) => f.type || "");
    let inputType = "text";
    if (types.some((t) => t === "input_file")) inputType = "file";
    else if (types.some((t) => t === "textarea")) inputType = "textarea";
    else if (types.some((t) => t.includes("multi_value_multi"))) inputType = "multi";
    else if (types.some((t) => t.includes("multi_value"))) inputType = "select";
    const options = [...new Set(fields.flatMap((f) => (f.values || []).map((v) => (v.label || "").trim()).filter(Boolean)))];
    out.push({ question, required: Boolean(q.required), inputType, ...(options.length ? { options } : {}) });
  }
  return out;
}

const SKIP = /^(autofill from resume|upload file|upload your resume|choose file|submit application|or drag and drop|type here|privacy policy|powered by)$/i;

export function normalizeQuestion(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/\*+\s*$/, "").trim();
}

export function parseApplicationQuestions(html: string): QuestionPrompt[] {
  const labels = [...html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => m[1]);
  const extras = [...html.matchAll(/aria-label="([^"]+)"/gi)].map((m) => m[1]);
  const seen = new Set<string>();
  const out: QuestionPrompt[] = [];
  for (const raw of [...labels, ...extras]) {
    const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.length < 2 || text.length > 400 || SKIP.test(text)) continue;
    const required = /\*\s*$/.test(text);
    const question = normalizeQuestion(text);
    if (!question || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    let inputType = "text";
    if (/resume|cv|cover letter/i.test(question)) inputType = "file";
    else if (question.length > 80 || /\?$/.test(question)) inputType = "textarea";
    out.push({ question, required, inputType });
  }
  if (out.length) return out;
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, "\n");
  for (const line of text.split("\n")) {
    const raw = line.replace(/\s+/g, " ").trim();
    if (!raw || raw.length < 2 || raw.length > 400 || SKIP.test(raw)) continue;
    if (!/\*$/.test(raw) && !/\?$/.test(raw)) continue;
    const required = /\*\s*$/.test(raw);
    const question = normalizeQuestion(raw);
    if (!question || seen.has(question.toLowerCase())) continue;
    if (!required && question.length < 24) continue;
    seen.add(question.toLowerCase());
    out.push({
      question,
      required,
      inputType: /resume|cv|cover letter/i.test(question) ? "file" : question.length > 80 || /\?$/.test(question) ? "textarea" : "text",
    });
  }
  return out;
}
