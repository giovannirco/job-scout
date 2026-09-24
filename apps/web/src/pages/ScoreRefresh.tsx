import { Link } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { post, useAction, useApi } from "@/lib/api";
import { Btn, ErrorNote } from "@/ui/kit";

type Progress = { total: number; unavailable: string | null; items: { id: string; state: string; error: string | null; retryAt: string | null }[] };
export function ScoreRefresh() {
  const q = useApi<Progress>(["triage-refresh"], "/api/v1/positions/refresh-stale-triage", { refetchInterval: 5_000 });
  const refresh = useAction(async () => post<{ enqueued: number; deduped: number }>("/api/v1/positions/refresh-stale-triage", { dryRun: false }), ["today", "positions", "triage-refresh"]);
  const items = q.data?.items ?? [];
  const pending = items.filter(p => ["queued", "running", "waiting"].includes(p.state)).length;
  const failed = items.filter(p => p.state === "failed").length;
  const waiting = items.filter(p => p.state === "waiting").length;
  return <div className="p-3 border-b border-border text-[12px] text-muted space-y-2" aria-live="polite">
    <p>These scores use an older profile. Refresh before relying on them; your application stages stay as they are.</p>
    {q.isError ? <ErrorNote error={q.error} /> : null}
    {pending ? <p>{pending} refreshes queued or running{waiting ? ` · ${waiting} waiting for a retry or daily budget` : ""}. Scores update when the worker finishes.</p> : null}
    {failed ? <p className="text-warn">{failed} refreshes failed. <Link to="/settings" search={{ tab: "system" }} className="underline">Inspect the errors</Link>, correct the cause, then retry.</p> : null}
    {q.data?.unavailable ? <p className="text-warn">Refresh paused: {q.data.unavailable}. <Link to="/settings" search={{ tab: "ai" }} className="underline">Check AI settings</Link>.</p> : null}
    <Btn size="xs" disabled={!q.data || !!q.data.unavailable || refresh.isPending || (items.length > 0 && pending === items.length)} onClick={() => {
      void refresh.mutateAsync().then(r => toast.success(`${r.enqueued} refreshes queued · ${r.deduped} already queued`)).catch(e => toast.error(e.message));
    }}><RotateCcw className="h-3 w-3" />{pending === items.length && pending > 0 ? "Refresh in progress" : failed ? "Retry score refresh" : "Refresh stale scores"}</Btn>
    {(q.data?.total ?? 0) > 25 ? <p>Refreshes run in batches of up to 25. Refresh again after this batch completes.</p> : null}
  </div>;
}
