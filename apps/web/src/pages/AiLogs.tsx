import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useChatScope } from "@/frame/store";
import { useApi } from "@/lib/api";
import { ago } from "@/lib/format";
import { Btn, Chip, ErrorNote, Loading, Page, PageHeader, Panel, Seg, cn } from "@/ui/kit";

export type LlmRunRow = {
  id: string;
  operation: string;
  model: string;
  positionId: string | null;
  positionTitle: string | null;
  status: "ok" | "error";
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  error: string | null;
  promptChars: number | null;
  responseChars: number | null;
  hasTranscript: boolean;
  createdAt: string;
};

export type LlmRunDetail = LlmRunRow & {
  prompt: string | null;
  response: string | null;
  promptTruncated: boolean;
  responseTruncated: boolean;
  positionSlug: string | null;
};

type Facets = { operations: { v: string; c: number }[]; models: { v: string; c: number }[] };

const ms = (n: number | null) => (n == null ? "—" : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);
const chars = (n: number | null) => (n == null ? "—" : n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

/** Transcripts are plain text, not markdown: render them verbatim so prompts are auditable. */
function Transcript({ title, body, truncated, chars: total }: { title: string; body: string | null; truncated: boolean; chars: number | null }) {
  if (!body) {
    return (
      <Panel title={title}>
        <div className="text-[12.5px] text-faint">
          Not recorded. Runs from before transcript capture, and streamed chat turns that failed before a first token, have no stored body.
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      title={title}
      meta={
        <span className="text-[11.5px] text-faint">
          {chars(total)} chars{truncated ? " · truncated for storage" : ""}
        </span>
      }
      actions={
        <Btn variant="outline" onClick={() => void navigator.clipboard?.writeText(body)}>
          Copy
        </Btn>
      }
    >
      <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-[1.5]">{body}</pre>
    </Panel>
  );
}

export function AiLogsPage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/ai-logs" });
  const navigate = useNavigate({ from: "/ai-logs" });
  const status = search.status || "all";
  const operation = search.operation || "";
  const selected = search.run || "";

  const qs = new URLSearchParams({ pageSize: "100" });
  if (operation) qs.set("operation", operation);
  if (status !== "all") qs.set("status", status);
  if (search.q) qs.set("q", search.q);

  const runs = useApi<{ items: LlmRunRow[]; total: number }>(["llm-runs", operation, status, search.q], `/api/v1/settings/llm/runs?${qs}`, {
    refetchInterval: 30_000,
  });
  const facets = useApi<Facets>(["llm-run-facets"], "/api/v1/settings/llm/runs/facets");
  const detail = useApi<LlmRunDetail>(["llm-run", selected], `/api/v1/settings/llm/runs/${selected}`, { enabled: Boolean(selected) });

  const items = runs.data?.items || [];
  const setSearch = (patch: Record<string, unknown>) => navigate({ search: (prev) => ({ ...prev, ...patch }) });

  return (
    <Page wide>
      <PageHeader
        title="AI logs"
        subtitle="Every model call, with what was asked and what came back."
        actions={<span className="text-[11.5px] text-faint">{runs.data?.total ?? 0} runs</span>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            value={status}
            onChange={(v) => setSearch({ status: v === "all" ? undefined : v })}
            options={[
              { value: "all", label: "All" },
              { value: "ok", label: "OK" },
              { value: "error", label: "Errors", tone: "bad" },
            ]}
          />
          <select
            value={operation}
            onChange={(e) => setSearch({ operation: e.target.value || undefined })}
            className="h-7 rounded-md border border-border bg-surface px-2 text-[12px]"
          >
            <option value="">All operations</option>
            {(facets.data?.operations || []).map((o) => (
              <option key={o.v} value={o.v}>
                {o.v} ({o.c})
              </option>
            ))}
          </select>
          <input
            defaultValue={search.q || ""}
            placeholder="Search prompt, response or error…"
            onKeyDown={(e) => {
              if (e.key === "Enter") setSearch({ q: (e.target as HTMLInputElement).value || undefined });
            }}
            className="h-7 w-[240px] rounded-md border border-border bg-surface px-2 text-[12px]"
          />
        </div>
      </PageHeader>

      {runs.error ? <ErrorNote error={runs.error} /> : null}

      <div className="grid gap-3 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <div className="min-w-0">
          {runs.isLoading ? (
            <Loading />
          ) : !items.length ? (
            <div className="rounded-md border border-border p-4 text-[12.5px] text-faint">No runs match these filters.</div>
          ) : (
            <div className="max-h-[72vh] overflow-auto rounded-md border border-border divide-y divide-border">
              {items.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSearch({ run: r.id })}
                  className={cn(
                    "w-full px-3 py-2 text-left hover:bg-surface-2",
                    selected === r.id && "bg-surface-3",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Chip tone={r.status === "error" ? "bad" : "neutral"}>{r.operation}</Chip>
                    <span className="truncate text-[12px] text-muted">{r.model}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{ago(r.createdAt)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11.5px] text-faint">
                    <span>{ms(r.latencyMs)}</span>
                    <span>·</span>
                    <span>
                      {r.tokensIn ?? "—"} in / {r.tokensOut ?? "—"} out
                    </span>
                    {r.hasTranscript ? null : <span className="ml-auto">no transcript</span>}
                  </div>
                  {r.positionTitle ? <div className="mt-0.5 truncate text-[11.5px] text-muted">{r.positionTitle}</div> : null}
                  {r.error ? <div className="mt-0.5 truncate text-[11.5px] text-bad">{r.error}</div> : null}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          {!selected ? (
            <div className="rounded-md border border-border p-4 text-[12.5px] text-faint">Pick a run to see the prompt and the model's answer.</div>
          ) : detail.isLoading ? (
            <Loading />
          ) : detail.error ? (
            <ErrorNote error={detail.error} />
          ) : detail.data ? (
            <>
              <Panel
                title={detail.data.operation}
                meta={
                  <span className="text-[11.5px] text-faint">
                    {detail.data.model} · {ms(detail.data.latencyMs)} · {detail.data.tokensIn ?? "—"} in / {detail.data.tokensOut ?? "—"} out ·{" "}
                    {new Date(detail.data.createdAt).toLocaleString()}
                  </span>
                }
                actions={
                  detail.data.positionId ? (
                    <Link to="/positions/$id" params={{ id: detail.data.positionId }}>
                      <Btn variant="outline">Open position</Btn>
                    </Link>
                  ) : null
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={detail.data.status === "error" ? "bad" : "good"}>{detail.data.status}</Chip>
                  {detail.data.positionTitle ? <span className="text-[12.5px] text-muted">{detail.data.positionTitle}</span> : null}
                </div>
                {detail.data.error ? <div className="mt-2 rounded-md bg-surface-2 p-2 text-[12px] text-bad">{detail.data.error}</div> : null}
              </Panel>
              <Transcript title="Prompt sent" body={detail.data.prompt} truncated={detail.data.promptTruncated} chars={detail.data.promptChars} />
              <Transcript title="Model response" body={detail.data.response} truncated={detail.data.responseTruncated} chars={detail.data.responseChars} />
            </>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
