import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Activity, Check, Inbox, MessageSquareText, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { post, type ActivityRow, type Approval } from "@/lib/api";
import { ago } from "@/lib/format";
import { Btn, Dot, Empty, IconBtn, Seg, cn, type Tone } from "@/ui/kit";
import { StatusBadge } from "@/components/badges";
import { ChatPanel } from "./Chat";
import { useToday } from "./Frame";
import { setUi, useUi, type DockTab } from "./store";

export function Dock() {
  const ui = useUi();
  const today = useToday();
  const pending = today.data?.approvals.length ?? 0;
  const running = (today.data?.queue || []).filter((q) => q.status === "running").reduce((n, q) => n + q.c, 0);

  return (
    <aside className="fixed inset-0 z-40 lg:static lg:z-auto lg:w-[380px] xl:w-[400px] shrink-0 border-l border-border bg-surface flex flex-col min-h-0">
      <div className="h-10 shrink-0 border-b border-border flex items-center gap-2 px-2">
        <Seg<DockTab>
          size="xs"
          value={ui.dockTab}
          onChange={(t) => setUi({ dockTab: t })}
          options={[
            { value: "wire", label: <span className="inline-flex items-center gap-1"><Activity className="h-3 w-3" />Wire</span>, count: running || null, tone: "accent" },
            { value: "inbox", label: <span className="inline-flex items-center gap-1"><Inbox className="h-3 w-3" />Inbox</span>, count: pending || null, tone: "accent" },
            { value: "chat", label: <span className="inline-flex items-center gap-1"><MessageSquareText className="h-3 w-3" />Chat</span> },
          ]}
        />
        <div className="flex-1" />
        <IconBtn label="Close panel" onClick={() => setUi({ dockOpen: false })}>
          <X className="h-3.5 w-3.5" />
        </IconBtn>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {ui.dockTab === "wire" ? <Wire rows={today.data?.activity || []} queue={today.data?.queue || []} /> : null}
        {ui.dockTab === "inbox" ? <InboxPanel items={today.data?.approvals || []} /> : null}
        {ui.dockTab === "chat" ? <ChatPanel /> : null}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ wire */

const KIND_TONE: Record<string, Tone> = {
  triage: "accent",
  triaged: "accent",
  evaluate: "info",
  evaluated: "info",
  materials: "info",
  company_research: "info",
  jd_review: "info",
  status: "good",
  status_change: "good",
  jd_change: "warn",
  jd_changed: "warn",
  closed: "bad",
  listing_closed: "bad",
  archived: "faint",
  note: "neutral",
  approval: "accent",
  created: "neutral",
  intake: "neutral",
};

function toneFor(kind: string): Tone {
  if (KIND_TONE[kind]) return KIND_TONE[kind];
  if (kind.includes("close")) return "bad";
  if (kind.includes("change")) return "warn";
  if (kind.includes("triage")) return "accent";
  if (kind.includes("eval") || kind.includes("research") || kind.includes("material")) return "info";
  if (kind.includes("status") || kind.includes("applied")) return "good";
  return "neutral";
}

function Wire({ rows, queue }: { rows: ActivityRow[]; queue: { status: string; type: string; c: number }[] }) {
  const running = queue.filter((q) => q.status === "running");
  const queued = queue.filter((q) => q.status === "queued");
  const firstId = useRef<string | null>(null);
  const newestId = rows[0]?.id ?? null;
  const isNew = firstId.current !== null && newestId !== firstId.current;
  useEffect(() => {
    firstId.current = newestId;
  }, [newestId]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {running.length || queued.length ? (
        <div className="px-3 py-2 border-b border-border bg-surface-2/50 space-y-1">
          {running.map((q) => (
            <div key={`r-${q.type}`} className="flex items-center gap-2 text-[11.5px]">
              <Dot tone="accent" pulse />
              <span className="font-mono text-accent">{q.type}</span>
              <span className="text-faint">running{q.c > 1 ? ` ×${q.c}` : ""}</span>
            </div>
          ))}
          {queued.length ? (
            <div className="flex items-center gap-2 text-[11px] text-faint">
              <Dot tone="faint" />
              <span className="font-mono">{queued.reduce((n, q) => n + q.c, 0)} queued</span>
              <span className="truncate">{queued.map((q) => `${q.type}×${q.c}`).join(" · ")}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="p-4 text-[12px] text-faint">Nothing has happened yet. Add a position or run discovery and the machine's work shows up here.</div>
      ) : (
        <ol className="py-1">
          {rows.map((r, i) => {
            const tone = toneFor(r.kind);
            return (
              <li key={r.id} className={cn("px-3 py-1.5 flex gap-2.5 text-[12px] hover:bg-surface-2/60", i === 0 && isNew && "wire-in")}>
                <div className="pt-[6px]">
                  <Dot tone={tone} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate leading-snug">{r.title}</span>
                    <span className="ml-auto font-mono text-[10px] text-faint tabular shrink-0">{ago(r.createdAt)}</span>
                  </div>
                  {r.slug ? (
                    <Link to="/positions/$id" params={{ id: r.slug }} className="block truncate text-[11px] text-muted hover:text-fg">
                      {r.company ? <span className="text-faint">{r.company} · </span> : null}
                      {r.positionTitle}
                    </Link>
                  ) : null}
                  <div className="font-mono text-[10px] text-faint">
                    {r.kind}
                    {r.actor ? ` · ${r.actor}` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ inbox */

export function InboxPanel({ items, full }: { items: Approval[]; full?: boolean }) {
  if (items.length === 0) {
    return (
      <div className={cn("p-4", full && "p-0")}>
        <Empty>
          Inbox is clear. Autopilot files suggestions here — status changes, drafted materials, archive candidates — and nothing moves until you approve it.
        </Empty>
      </div>
    );
  }
  return (
    <div className={cn("flex-1 min-h-0 overflow-y-auto", full ? "space-y-2" : "divide-y divide-border")}>
      {items.map((a) => (
        <ApprovalCard key={a.id} a={a} full={full} />
      ))}
    </div>
  );
}

function ApprovalCard({ a, full }: { a: Approval; full?: boolean }) {
  const qc = useQueryClient();
  const raw = a.payload as { toStatus?: string; to?: string; reason?: string; score?: number; materialIds?: string[]; surface?: string };
  const p = { ...raw, to: raw.toStatus ?? raw.to, from: a.position?.status };
  const resolve = async (decision: "approve" | "dismiss") => {
    try {
      await post(`/api/v1/approvals/${a.id}/${decision}`);
      toast.success(decision === "approve" ? "Approved" : "Dismissed");
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["positions"] });
      if (a.position) qc.invalidateQueries({ queryKey: ["position", a.position.slug] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };
  const kindLabel = a.kind === "status_suggestion" ? "Status" : a.kind === "materials_draft" ? "Materials" : "Archive";
  const kindTone: Tone = a.kind === "status_suggestion" ? "good" : a.kind === "materials_draft" ? "info" : "warn";

  return (
    <div className={cn("p-3 space-y-2", full && "rounded-lg border border-border bg-surface")}>
      <div className="flex items-center gap-2">
        <Dot tone={kindTone} />
        <span className="eyebrow">{kindLabel}</span>
        <span className="ml-auto font-mono text-[10px] text-faint tabular">{ago(a.createdAt)}</span>
      </div>
      <div className="text-[12.5px] leading-snug">{a.title}</div>
      {a.position ? (
        <Link to="/positions/$id" params={{ id: a.position.slug }} className="flex items-center gap-2 text-[11.5px] text-muted hover:text-fg min-w-0">
          <span className="truncate">
            <span className="text-faint">{a.position.company} · </span>
            {a.position.title}
          </span>
          <StatusBadge status={a.position.status} className="ml-auto shrink-0" />
        </Link>
      ) : null}
      {a.body ? <p className="text-[12px] text-muted leading-relaxed whitespace-pre-wrap">{a.body}</p> : null}
      {a.kind === "status_suggestion" && p.to ? (
        <div className="flex items-center gap-1.5 text-[11.5px]">
          {p.from ? <StatusBadge status={p.from} /> : null}
          <span className="text-faint">→</span>
          <StatusBadge status={p.to} />
          {p.score != null ? <span className="font-mono text-faint tabular ml-1">{p.score.toFixed(1)}</span> : null}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 pt-1">
        <Btn size="xs" variant="primary" onClick={() => resolve("approve")}>
          <Check className="h-3 w-3" />
          {a.kind === "status_suggestion" ? `Move to ${p.to ?? "status"}` : a.kind === "archive_suggestion" ? "Archive" : "Accept draft"}
        </Btn>
        <Btn size="xs" variant="ghost" onClick={() => resolve("dismiss")}>
          Dismiss
        </Btn>
      </div>
    </div>
  );
}

export function DockShellRow({ children }: { children: ReactNode }) {
  return <div className="px-3 py-2 border-b border-border">{children}</div>;
}
