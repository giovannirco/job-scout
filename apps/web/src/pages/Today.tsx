import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Inbox, RadarIcon, RotateCcw, X } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ScoreMeter, STATUS_LABEL, STATUS_PATH, STATUS_TONE, StatusBadge } from "@/components/badges";
import { InboxPanel } from "@/frame/Dock";
import { openDock, useChatScope } from "@/frame/store";
import { patch, post, useAction, useApi, type AutopilotState, type PipelineStatus, type SystemInfo, type TodayData, type TodaySlim } from "@/lib/api";
import { ago, compact, dateTime } from "@/lib/format";
import { Btn, Empty, ErrorNote, Loading, Monogram, Page, PageHeader, Panel, TONE_DOT, TONE_TEXT, cn } from "@/ui/kit";

export function TodayPage() {
  useChatScope({ scope: "global" });
  const qc = useQueryClient();
  const q = useApi<TodayData>(["today"], "/api/v1/today", { refetchInterval: 30_000 });
  const auto = useApi<AutopilotState>(["autopilot"], "/api/v1/settings/autopilot", { staleTime: 60_000 });
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const d = q.data;

  if (q.isLoading) return <Page><Loading rows={6} /></Page>;
  if (q.isError || !d) return <Page><ErrorNote error={q.error ?? "Could not load today"} /></Page>;

  const byStatus = d.counts.byStatus;
  const running = d.queue.filter((x) => x.status === "running").reduce((n, x) => n + x.c, 0);
  const queued = d.queue.filter((x) => x.status === "queued").reduce((n, x) => n + x.c, 0);
  const failed = d.queue.filter((x) => x.status === "failed").reduce((n, x) => n + x.c, 0);
  const llmRuns = d.llm.byOperation.reduce((n, r) => n + r.runs, 0);
  const llmTokens = d.llm.byOperation.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0);
  const llmFails = d.llm.byOperation.reduce((n, r) => n + r.failures, 0);

  const needs = d.decisions.length + d.approvals.length + d.upcoming.length;
  const bits: string[] = [];
  if (d.decisions.length) bits.push(`${d.decisions.length} PASS ${d.decisions.length === 1 ? "verdict" : "verdicts"} to decide`);
  if (d.approvals.length) bits.push(`${d.approvals.length} autopilot ${d.approvals.length === 1 ? "suggestion" : "suggestions"}`);
  if (d.upcoming.length) bits.push(`${d.upcoming.length} ${d.upcoming.length === 1 ? "interview" : "interviews"} scheduled`);
  if (d.followUps.length) bits.push(`${d.followUps.length} stale ${d.followUps.length === 1 ? "application" : "applications"}`);
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <Page wide>
      <PageHeader
        eyebrow={dateLabel}
        title={needs === 0 ? "Nothing needs you right now" : `${needs} ${needs === 1 ? "thing needs" : "things need"} you`}
        subtitle={bits.length ? bits.join(" · ") : "The machine keeps scanning. Add a URL or run discovery to feed it."}
        actions={
          <>
            {auto.data ? (
              <Link to="/settings" search={{ tab: "autopilot" }} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-[12px] text-muted hover:text-fg hover:bg-surface-2">
                <span className={cn("h-1.5 w-1.5 rounded-full", auto.data.preset === "autopilot" ? "bg-good" : auto.data.preset === "manual" ? "bg-faint" : "bg-accent")} />
                <span className="capitalize">{auto.data.preset}</span>
              </Link>
            ) : null}
            <Btn
              onClick={async () => {
                const r = await post<{ enqueued: number }>("/api/v1/radar/boards/scan-all");
                toast.success(`Discovery queued for ${r.enqueued} boards`);
              }}
            >
              <RadarIcon className="h-3.5 w-3.5" /> Run discovery
            </Btn>
          </>
        }
      >
        <Funnel byStatus={byStatus} untriaged={d.counts.untriaged} last30d={d.counts.last30d} appliedThisWeek={d.counts.appliedThisWeek} />
        {sys.data && !sys.data.llmConfigured ? (
          <p className="text-[12.5px] text-muted">
            No model key is set, so discovery files listings without scoring them.{" "}
            <Link to="/settings" search={{ tab: "ai" }} className="text-accent hover:underline">Add a key in Settings</Link>
            {" "}when you want triage.
          </p>
        ) : null}
      </PageHeader>

      <div className="grid lg:grid-cols-[1fr_340px] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          <Panel
            title="Decide"
            meta={`${d.decisions.length} PASS`}
            actions={
              <Link to="/pipeline" search={{ verdict: "pass", status: "triaged" }} className="text-[11.5px] text-muted hover:text-fg inline-flex items-center gap-1">
                All <ArrowRight className="h-3 w-3" />
              </Link>
            }
            flush
          >
            {d.decisions.length === 0 ? (
              <div className="p-3">
                <Empty>No PASS verdicts waiting. Discovery keeps running; new matches land here.</Empty>
              </div>
            ) : (
              <DecisionList rows={d.decisions} />
            )}
          </Panel>

          {d.approvals.length ? (
            <Panel
              title="Autopilot suggestions"
              meta={`${d.approvals.length} pending`}
              actions={
                <button type="button" onClick={() => openDock("inbox")} className="text-[11.5px] text-muted hover:text-fg inline-flex items-center gap-1">
                  <Inbox className="h-3 w-3" /> Open inbox
                </button>
              }
              flush
            >
              <InboxPanel items={d.approvals.slice(0, 4)} />
            </Panel>
          ) : null}

          <Panel title="Changed on active positions" meta="7 days" flush>
            {d.changed.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">No JD changes on positions past triage this week.</div>
            ) : (
              <div className="divide-y divide-border/60">
                {d.changed.map((r) => (
                  <RowLink key={r.id} r={r} right={<span className="text-faint font-mono text-[11px] tabular">{ago(r.lastChangedAt)} ago</span>} />
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-5 min-w-0">
          <Panel
            title="Interviews"
            meta={d.upcoming.length ? `${d.upcoming.length}` : undefined}
            actions={
              <Link to="/interviews" className="text-[11.5px] text-muted hover:text-fg inline-flex items-center gap-1">
                All <ArrowRight className="h-3 w-3" />
              </Link>
            }
            flush
          >
            {d.upcoming.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">None scheduled.</div>
            ) : (
              <div className="divide-y divide-border/60">
                {d.upcoming.map((i) => (
                  <Link key={i.id} to="/positions/$id" params={{ id: i.slug }} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-2/60">
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px]">{i.title}</div>
                      <div className="text-[11px] text-muted truncate">
                        {i.company} · {i.stage}
                      </div>
                    </div>
                    <div className="font-mono text-[11px] text-accent shrink-0 tabular">{dateTime(i.scheduledAt)}</div>
                  </Link>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Follow up" meta="applied > 7d" flush>
            {d.followUps.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-faint">No stale applications.</div>
            ) : (
              <div className="divide-y divide-border/60">
                {d.followUps.map((r) => (
                  <RowLink key={r.id} r={r} right={<span className="text-faint font-mono text-[11px] tabular">{ago(r.appliedAt)}</span>} />
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Machine"
            meta="24h"
            actions={
              <div className="flex items-center gap-2">
                {llmFails > 0 ? (
                  <Btn
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        const r = await post<{ enqueued: number; items: unknown[] }>("/api/v1/settings/llm/retry", {
                          hours: 24,
                          scope: "failed_and_missing",
                        });
                        toast.success(`Retry queued: ${r.items.length} jobs`);
                        void qc.invalidateQueries({ queryKey: ["today"] });
                        void qc.invalidateQueries({ queryKey: ["llm"] });
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Retry failed");
                      }
                    }}
                  >
                    <RotateCcw className="h-3 w-3" /> Retry failed
                  </Btn>
                ) : null}
                <Link to="/settings" search={{ tab: "ai" }} className="text-[11.5px] text-muted hover:text-fg">
                  Models
                </Link>
              </div>
            }
          >
            <div className="grid grid-cols-3 gap-2 mb-3">
              <Mini label="LLM calls" value={llmRuns} />
              <Mini label="tokens" value={compact(llmTokens)} />
              <Mini label="queue" value={running ? `${running}▸ ${queued}` : String(queued)} tone={running ? "accent" : failed ? "bad" : undefined} hint={failed ? `${failed} failed` : undefined} />
            </div>
            {d.llm.remaining?.length ? (
              <div className="space-y-1.5 mb-3">
                {d.llm.remaining.map((r) => (
                  <div key={r.operation} className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-[11.5px]">
                    <span className="font-mono text-muted truncate">{r.operation}</span>
                    <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                      <div
                        className={cn("h-full rounded-full", r.cap > 0 && r.remaining === 0 ? "bg-bad" : "bg-accent")}
                        style={{ width: `${r.cap > 0 ? Math.max(3, (r.used / r.cap) * 100) : r.used ? 8 : 0}%` }}
                      />
                    </div>
                    <span className="font-mono tabular text-faint">
                      {r.cap > 0 ? `${r.remaining} left · ${r.used}/${r.cap}` : `${r.used} · no cap`}
                    </span>
                  </div>
                ))}
              </div>
            ) : d.llm.byOperation.length === 0 ? (
              <div className="text-[12px] text-faint">No model calls in the last day.</div>
            ) : (
              <div className="space-y-1.5">
                {d.llm.byOperation
                  .slice()
                  .sort((a, b) => b.runs - a.runs)
                  .map((r) => (
                    <div key={r.operation} className="grid grid-cols-[92px_1fr_auto] items-center gap-2 text-[11.5px]">
                      <span className="font-mono text-muted truncate">{r.operation}</span>
                      <div className="h-1.5 rounded-full bg-surface-3 overflow-hidden">
                        <div className={cn("h-full rounded-full", r.failures ? "bg-warn" : "bg-accent")} style={{ width: `${Math.max(3, (r.runs / Math.max(1, llmRuns)) * 100)}%` }} />
                      </div>
                      <span className="font-mono tabular text-faint">
                        {r.runs}
                        {r.failures ? <span className="text-bad"> · {r.failures}✕</span> : null}
                        <span className="text-faint"> · {(r.avgLatencyMs / 1000).toFixed(1)}s</span>
                      </span>
                    </div>
                  ))}
              </div>
            )}
            {auto.data ? (
              <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-2">
                <Mini label="budget · calls" value={auto.data.budget.dailyCalls ? `${auto.data.budgetToday.calls}/${auto.data.budget.dailyCalls}` : `${auto.data.budgetToday.calls}`} hint={auto.data.budget.dailyCalls ? undefined : "no cap"} />
                <Mini label="budget · tokens" value={compact(auto.data.budgetToday.tokens)} hint={auto.data.budget.dailyTokens ? `of ${compact(auto.data.budget.dailyTokens)}` : "no cap"} />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </Page>
  );
}

/** The pipeline as one band: each stage's width is its share of live positions. */
const FUNNEL_30D: PipelineStatus[] = ["triaged", "review", "applied", "interview", "offer", "archived"];

function Funnel({
  byStatus,
  untriaged,
  last30d,
  appliedThisWeek,
}: {
  byStatus: Record<string, number>;
  untriaged: number;
  last30d: Record<string, number>;
  appliedThisWeek: number;
}) {
  const navigate = useNavigate();
  const stages = STATUS_PATH.map((s) => ({ s, n: byStatus[s] || 0 }));
  const total = stages.reduce((n, x) => n + x.n, 0) || 1;
  const terminal = (byStatus.rejected || 0) + (byStatus.skip || 0);
  const extra30 = Object.entries(last30d || {}).filter(([s, n]) => n > 0 && !FUNNEL_30D.includes(s as PipelineStatus));
  return (
    <div className="space-y-1.5">
      <div className="flex h-8 rounded-md overflow-hidden border border-border bg-surface">
        {stages.map(({ s, n }) => {
          const tone = STATUS_TONE[s as PipelineStatus];
          const pct = Math.max(n ? 6 : 0, (n / total) * 100);
          if (!n) return null;
          return (
            <button
              key={s}
              type="button"
              title={`${STATUS_LABEL[s as PipelineStatus]} · ${n}`}
              onClick={() => navigate({ to: "/pipeline", search: { status: s } })}
              style={{ width: `${pct}%` }}
              className={cn("relative flex items-center gap-1.5 px-2 border-r border-bg last:border-r-0 hover:brightness-110 transition-[filter] min-w-0 text-left", s === "triaged" ? "bg-surface-3" : "bg-surface-2")}
            >
              <span className={cn("h-full w-[3px] absolute left-0 top-0", TONE_DOT[tone])} />
              <span className="font-mono text-[12px] tabular pl-1">{n}</span>
              <span className="text-[11px] text-muted truncate hidden sm:inline">{STATUS_LABEL[s as PipelineStatus]}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 font-mono text-[10.5px] text-faint tabular flex-wrap">
        <span>{total} live</span>
        {untriaged ? (
          <Link to="/pipeline" search={{ verdict: "none", status: "triaged" }} className="text-warn hover:underline">
            {untriaged} untriaged
          </Link>
        ) : null}
        <span>{terminal} rejected/skipped</span>
        <span>{byStatus.archived || 0} archived</span>
      </div>
      <div className="flex items-center gap-3 font-mono text-[10.5px] text-muted tabular flex-wrap">
        <span className="text-faint">30d</span>
        {FUNNEL_30D.map((s) => (
          <button key={s} type="button" className="hover:text-fg" onClick={() => navigate({ to: "/pipeline", search: { status: s } })}>
            {last30d?.[s] || 0} {STATUS_LABEL[s].toLowerCase()}
          </button>
        ))}
        {extra30.map(([s, n]) => (
          <span key={s}>
            {n} {STATUS_LABEL[s as PipelineStatus]?.toLowerCase() || s}
          </span>
        ))}
        <span className="text-fg">{appliedThisWeek || 0} applied this week</span>
      </div>
    </div>
  );
}

function Mini({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "accent" | "bad" | "good" | "warn" }) {
  return (
    <div className="rounded-md bg-surface-2/70 px-2.5 py-2">
      <div className="eyebrow">{label}</div>
      <div className={cn("font-display text-[18px] font-semibold tabular leading-none mt-1.5", tone ? TONE_TEXT[tone] : "")}>{value}</div>
      {hint ? <div className="text-[10.5px] text-faint mt-1">{hint}</div> : null}
    </div>
  );
}

function RowLink({ r, right }: { r: TodaySlim; right?: ReactNode }) {
  return (
    <Link to="/positions/$id" params={{ id: r.slug }} className="flex items-center gap-3 px-3 py-2 hover:bg-surface-2/60">
      <Monogram name={r.company.name} size={24} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]">{r.title}</div>
        <div className="text-[11px] text-muted truncate">{r.company.name}</div>
      </div>
      <StatusBadge status={r.status} />
      {right}
    </Link>
  );
}

function DecisionList({ rows }: { rows: TodaySlim[] }) {
  const navigate = useNavigate();
  const decide = useAction(
    async ({ id, status }: { id: string; status: string }) => {
      await patch(`/api/v1/positions/${id}`, { status });
      return status;
    },
    ["today", "positions"],
  );

  return (
    <div className="divide-y divide-border/60">
      {rows.map((r) => (
        <div key={r.id} className="px-3 py-2.5 flex items-start gap-3 group">
          <Monogram name={r.company.name} size={30} className="mt-0.5" />
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate({ to: "/positions/$id", params: { id: r.slug } })}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate text-[13px] font-medium">{r.title}</span>
              <span className="text-muted text-[12px] truncate shrink-0 max-w-[40%]">{r.company.name}</span>
            </div>
            {r.triageOneLiner ? <div className="text-[12px] text-muted line-clamp-2 leading-snug mt-0.5">{r.triageOneLiner}</div> : null}
          </button>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <ScoreMeter score={r.triageScore} verdict={r.triageVerdict} />
            <div className="flex items-center gap-1">
              <Btn size="xs" variant="primary" title="Move to review" onClick={() => decide.mutateAsync({ id: r.id, status: "review" }).then(() => toast.success("Moved to review"))}>
                <Check className="h-3 w-3" /> Review
              </Btn>
              <Btn size="xs" variant="ghost" title="Skip" onClick={() => decide.mutateAsync({ id: r.id, status: "skip" }).then(() => toast("Skipped"))}>
                <X className="h-3 w-3" />
              </Btn>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
