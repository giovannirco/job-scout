import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { InterviewRoundBody } from "@/components/interview-round";
import { StatusBadge } from "@/components/badges";
import { useChatScope } from "@/frame/store";
import { qs, useApi, type Interview } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { InterviewsSearch } from "@/router";
import { Empty, ErrorNote, Loading, Monogram, Page, PageHeader, Seg, cn } from "@/ui/kit";

type Lane = "all" | "upcoming" | "completed" | "needs_brief";

export function InterviewsPage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/interviews" });
  const navigate = useNavigate({ from: "/interviews" });
  const qc = useQueryClient();
  const lane = (search.lane as Lane) || "all";
  const selected = search.id || "";
  const set = (patch: Partial<InterviewsSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }) });

  const list = useApi<Interview[]>(["interviews-desk", lane, search.q, search.stage], `/api/v1/interviews${qs({ lane, q: search.q, stage: search.stage })}`, { refetchInterval: 30_000 });
  const rows = list.data || [];
  const current = rows.find((r) => r.id === selected) || rows[0];

  return (
    <Page wide>
      <PageHeader
        title="Interviews"
        subtitle="Every logged round: notes, transcript, AI brief vs the JD. Add new rounds on the position."
        actions={<span className="text-[11.5px] text-faint">{rows.length} rounds</span>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Seg<Lane>
            value={lane}
            onChange={(v) => set({ lane: v === "all" ? undefined : v, id: undefined })}
            options={[
              { value: "all", label: "All" },
              { value: "upcoming", label: "Upcoming" },
              { value: "completed", label: "Done" },
              { value: "needs_brief", label: "Needs AI brief" },
            ]}
          />
          <input
            aria-label="Search rounds"
            key={search.q || ""}
            defaultValue={search.q || ""}
            placeholder="Company, role, interviewer…"
            onKeyDown={(e) => {
              if (e.key === "Enter") void set({ q: (e.target as HTMLInputElement).value.trim() || undefined });
            }}
            className="h-7 w-[240px] rounded-md border border-border bg-bg px-2 text-[12px] outline-none focus:border-accent"
          />
        </div>
      </PageHeader>

      {list.isLoading ? (
        <Loading rows={6} />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !rows.length ? (
        <Empty>No rounds yet. Log a screen or interview on a position — upcoming ones also show on Today.</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(320px,400px)_1fr]">
          <div className="max-h-[72vh] overflow-auto rounded-md border border-border divide-y divide-border/60">
            {rows.map((r) => {
              const when = r.occurredAt || r.scheduledAt;
              const active = current?.id === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => set({ id: r.id })}
                  className={cn("w-full px-3 py-2 text-left hover:bg-surface-2", active && "bg-surface-3")}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Monogram name={r.companyName || "?"} className="h-6 w-6 text-[10px]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium">
                        {r.companyName} · {r.title || r.stage.replace(/_/g, " ")}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {r.interviewerName || "unassigned"}
                        {r.outcome ? ` · ${r.outcome}` : ""}
                        {(r.transcriptChars ?? 0) > 0 ? " · transcript" : ""}
                        {r.aiBriefedAt ? " · AI brief" : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-[10.5px] text-faint tabular">{when ? dateTime(when) : "—"}</div>
                      <div className="text-[10px] text-muted">{r.status}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {current ? (
            <div className="min-w-0 rounded-md border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[15px] font-medium truncate">{current.title || current.stage.replace(/_/g, " ")}</div>
                  <div className="text-[12px] text-muted">
                    {current.interviewerName}
                    {current.interviewerRole ? ` · ${current.interviewerRole}` : ""}
                  </div>
                </div>
                <StatusBadge status={current.positionStatus || "review"} />
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
                <Link to="/positions/$id" params={{ id: current.positionSlug || current.positionId }} className="text-accent hover:underline">
                  {current.companyName} · {current.positionTitle}
                </Link>
                <Link to="/process" search={{ id: current.positionId }} className="text-muted hover:text-fg">
                  Process
                </Link>
              </div>
              <InterviewRoundBody
                positionId={current.positionId}
                row={current}
                tall
                onBrief={() => {
                  void qc.invalidateQueries({ queryKey: ["interviews-desk"] });
                  void qc.invalidateQueries({ queryKey: ["interview", current.positionId, current.id] });
                }}
              />
            </div>
          ) : null}
        </div>
      )}
    </Page>
  );
}
