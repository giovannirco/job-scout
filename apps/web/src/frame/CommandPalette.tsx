import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, Briefcase, Building2, CornerDownLeft, Search, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ScoreMeter, StatusBadge } from "@/components/badges";
import { api, post, useApi, type CompanyRow, type PositionRow, type SystemInfo } from "@/lib/api";
import { discoveryQueuedMessage } from "@/lib/discovery-toast";
import { Kbd, Monogram, cn } from "@/ui/kit";
import { setUi, toggleDock } from "./store";

type Item =
  | { kind: "nav"; id: string; label: string; hint?: string; to: string; search?: Record<string, unknown> }
  | { kind: "action"; id: string; label: string; hint?: string; run: () => void | Promise<void> }
  | { kind: "position"; id: string; row: PositionRow }
  | { kind: "company"; id: string; row: CompanyRow };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const trimmed = q.trim();
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const noKey = sys.data?.llmConfigured === false;
  const positions = useQuery<PositionRow[]>({
    queryKey: ["palette", "positions", trimmed],
    queryFn: () => api<PositionRow[]>(`/api/v1/positions?q=${encodeURIComponent(trimmed)}&status=active&pageSize=8`),
    enabled: open && trimmed.length >= 2,
    staleTime: 10_000,
  });
  const companies = useQuery<CompanyRow[]>({
    queryKey: ["palette", "companies", trimmed],
    queryFn: () => api<CompanyRow[]>(`/api/v1/companies?q=${encodeURIComponent(trimmed)}&withPositions=true&pageSize=5`),
    enabled: open && trimmed.length >= 2,
    staleTime: 10_000,
  });

  const staticItems: Item[] = useMemo(
    () => [
      { kind: "action", id: "add", label: "Add position from URL", hint: noKey ? "fetch · gate" : "fetch · gate · triage", run: () => setUi({ addOpen: true }) },
      { kind: "action", id: "chat", label: "Open chat", hint: "⌘J", run: () => toggleDock("chat") },
      { kind: "action", id: "inbox", label: "Open inbox", hint: "⌘I", run: () => toggleDock("inbox") },
      {
        kind: "action",
        id: "discovery",
        label: "Run discovery now",
        hint: "scan boards that are due",
        run: async () => {
          const r = await post<{ enqueued: number }>("/api/v1/radar/boards/scan-all");
          const text = discoveryQueuedMessage(r);
          if (r.enqueued > 0) toast.success(text);
          else toast.message(text);
          void qc.invalidateQueries({ queryKey: ["today"] });
        },
      },
      { kind: "nav", id: "today", label: "Today", to: "/today" },
      { kind: "nav", id: "pipeline", label: "Pipeline", to: "/pipeline" },
      { kind: "nav", id: "process", label: "Process", to: "/process", hint: "live loops" },
      { kind: "nav", id: "interviews", label: "Interviews", to: "/interviews", hint: "transcripts and briefs" },
      noKey
        ? { kind: "nav", id: "unscored", label: "Pipeline · not scored", to: "/pipeline", search: { verdict: "none", status: "triaged", sort: "first_seen_desc" } }
        : { kind: "nav", id: "pass", label: "Pipeline · PASS awaiting decision", to: "/pipeline", search: { verdict: "pass", status: "triaged", sort: "score_desc" } },
      { kind: "nav", id: "board", label: "Pipeline · board view", to: "/pipeline", search: { view: "board" } },
      { kind: "nav", id: "radar", label: "Radar", to: "/radar" },
      { kind: "nav", id: "companies", label: "Companies", to: "/companies" },
      { kind: "nav", id: "ai-logs", label: "AI logs", to: "/ai-logs" },
      { kind: "nav", id: "inboxp", label: "Inbox", to: "/inbox" },
      { kind: "nav", id: "ai", label: "Settings · AI models", to: "/settings", search: { tab: "ai" } },
      { kind: "nav", id: "autopilot", label: "Settings · Autopilot", to: "/settings", search: { tab: "autopilot" } },
      { kind: "nav", id: "system", label: "Settings · System", to: "/settings", search: { tab: "system" } },
    ],
    [qc, noKey],
  );

  const items: Item[] = useMemo(() => {
    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
    const st = words.length ? staticItems.filter((i) => match(i.kind === "position" || i.kind === "company" ? "" : i.label + " " + (i.hint || ""))) : staticItems;
    const ps: Item[] = (positions.data || []).map((row) => ({ kind: "position", id: `p:${row.id}`, row }));
    const cs: Item[] = (companies.data || []).map((row) => ({ kind: "company", id: `c:${row.id}`, row }));
    return [...ps, ...cs, ...st];
  }, [trimmed, staticItems, positions.data, companies.data]);

  useEffect(() => setIdx(0), [items.length, trimmed]);

  const run = async (it: Item) => {
    onClose();
    if (it.kind === "nav") void navigate({ to: it.to, search: it.search as never });
    else if (it.kind === "action") await it.run();
    else if (it.kind === "position") void navigate({ to: "/positions/$id", params: { id: it.row.slug } });
    else if (it.kind === "company") void navigate({ to: "/companies/$id", params: { id: it.row.slug } });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-3 pt-[12vh]">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative z-10 w-full max-w-xl rounded-xl border border-border bg-surface shadow-pop overflow-hidden" role="dialog" aria-modal="true">
        <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
          <Search className="h-4 w-4 text-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search positions, companies, or type an action…"
            className="flex-1 bg-transparent outline-none text-[13.5px] placeholder:text-faint"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(items.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter" && items[idx]) void run(items[idx]!);
              else if (e.key === "Escape") onClose();
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="max-h-[56vh] overflow-y-auto py-1">
          {items.length === 0 ? <div className="px-3 py-6 text-center text-[12.5px] text-faint">Nothing matches “{trimmed}”.</div> : null}
          {items.map((it, i) => {
            const active = i === idx;
            return (
              <button
                key={it.id}
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => void run(it)}
                className={cn("w-full flex items-center gap-2.5 px-3 h-10 text-left text-[12.5px]", active ? "bg-surface-2" : "")}
              >
                {it.kind === "position" ? (
                  <>
                    <Monogram name={it.row.company.name} size={22} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-faint">{it.row.company.name} · </span>
                      {it.row.title}
                    </span>
                    <ScoreMeter score={it.row.triageScore} verdict={it.row.triageVerdict} />
                    <StatusBadge status={it.row.status} />
                  </>
                ) : it.kind === "company" ? (
                  <>
                    <Building2 className="h-4 w-4 text-faint" />
                    <span className="flex-1 truncate">{it.row.name}</span>
                    <span className="font-mono text-[10.5px] text-faint tabular">
                      {it.row.positionsOpen} open · {it.row.positionsHot} hot
                    </span>
                  </>
                ) : (
                  <>
                    {it.kind === "action" ? <Zap className="h-4 w-4 text-accent" /> : <Briefcase className="h-4 w-4 text-faint" />}
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint ? <span className="font-mono text-[10.5px] text-faint">{it.hint}</span> : null}
                    {it.kind === "nav" ? <ArrowRight className="h-3.5 w-3.5 text-faint" /> : null}
                  </>
                )}
                {active ? <CornerDownLeft className="h-3 w-3 text-faint" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
