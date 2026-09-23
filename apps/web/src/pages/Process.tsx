import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { InterviewRoundBody } from "@/components/interview-round";
import { StatusBadge } from "@/components/badges";
import { useChatScope } from "@/frame/store";
import { useApi, type ProcessRow } from "@/lib/api";
import { dateTime } from "@/lib/format";
import type { ProcessSearch } from "@/router";
import { Empty, ErrorNote, Loading, Monogram, Page, PageHeader, cn } from "@/ui/kit";

export function ProcessPage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/process" });
  const navigate = useNavigate({ from: "/process" });
  const qc = useQueryClient();
  const selectedId = search.id || "";
  const [openRound, setOpenRound] = useState<string | null>(null);
  const list = useApi<ProcessRow[]>(["processes"], "/api/v1/processes", { refetchInterval: 30_000 });
  const rows = list.data || [];
  const current = rows.find((r) => r.id === selectedId) || rows[0];
  const setId = (id: string) => {
    setOpenRound(null);
    void navigate({ search: (prev) => ({ ...prev, id }) });
  };

  return (
    <Page wide>
      <PageHeader
        title="Process"
        subtitle="Live loops — applied, screen, interview, offer. Open a row for the round timeline."
        actions={<span className="text-[11.5px] text-faint">{rows.length} in play</span>}
      />

      {list.isLoading ? (
        <Loading rows={6} />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !rows.length ? (
        <Empty>No live processes. Positions land here once they are applied, in screen, interview, or offer.</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(320px,400px)_1fr]">
          <div className="max-h-[72vh] overflow-auto rounded-md border border-border divide-y divide-border/60">
            {rows.map((r) => {
              const active = current?.id === r.id;
              const when = r.nextRound?.scheduledAt || r.lastRound?.occurredAt;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setId(r.id)}
                  className={cn("w-full px-3 py-2 text-left hover:bg-surface-2", active && "bg-surface-3")}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Monogram name={r.company.name} className="h-6 w-6 text-[10px]" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium">
                        {r.company.name} · {r.title}
                      </div>
                      <div className="truncate text-[11px] text-muted">
                        {r.roundCount} {r.roundCount === 1 ? "round" : "rounds"}
                        {r.nextRound ? ` · next ${r.nextRound.stage.replace(/_/g, " ")}` : r.lastRound ? ` · last ${r.lastRound.stage.replace(/_/g, " ")}` : ""}
                        {r.nextAction ? ` · ${r.nextAction}` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <StatusBadge status={r.status} />
                      <div className="font-mono text-[10.5px] text-faint tabular mt-0.5">{when ? dateTime(when) : "—"}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {current ? (
            <div className="min-w-0 rounded-md border border-border bg-surface p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[15px] font-medium truncate">{current.title}</div>
                  <div className="text-[12px] text-muted">{current.company.name}</div>
                </div>
                <StatusBadge status={current.status} />
              </div>
              {current.nextAction ? <div className="text-[12.5px]"><span className="text-faint">Next · </span>{current.nextAction}</div> : null}
              {current.notes ? <div className="text-[12px] text-muted whitespace-pre-wrap">{current.notes}</div> : null}
              <div className="flex gap-3 text-[12px]">
                <Link to="/positions/$id" params={{ id: current.slug }} className="text-accent hover:underline">
                  Position
                </Link>
                <Link to="/interviews" search={{ q: current.company.name }} className="text-muted hover:text-fg">
                  All rounds
                </Link>
              </div>
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-faint mb-2">Rounds</div>
                {current.rounds.length === 0 ? (
                  <div className="text-[12px] text-faint">No rounds logged. Add them on the position page.</div>
                ) : (
                  <div className="divide-y divide-border/60 rounded-md border border-border">
                    {current.rounds.map((r) => {
                      const open = openRound === r.id;
                      const when = r.occurredAt || r.scheduledAt;
                      return (
                        <div key={r.id} className="px-3 py-2">
                          <button type="button" className="w-full text-left" onClick={() => setOpenRound(open ? null : r.id)}>
                            <div className="text-[12.5px] font-medium">
                              {r.title || r.stage.replace(/_/g, " ")}
                              {r.outcome ? <span className="text-muted font-normal"> · {r.outcome}</span> : null}
                            </div>
                            <div className="text-[11px] text-muted">
                              {r.interviewerName || "unassigned"} · {r.status}
                              {when ? ` · ${dateTime(when)}` : ""}
                              {r.transcriptChars ? " · transcript" : ""}
                              {r.aiBriefedAt ? " · AI brief" : ""}
                            </div>
                          </button>
                          {open ? (
                            <InterviewRoundBody
                              positionId={current.id}
                              row={r}
                              tall
                              onBrief={() => {
                                void qc.invalidateQueries({ queryKey: ["processes"] });
                                void qc.invalidateQueries({ queryKey: ["interview", current.id, r.id] });
                              }}
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Page>
  );
}
