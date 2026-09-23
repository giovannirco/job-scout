import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ExternalLink, MessageSquareText, Play, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ListingBadge, ScoreMeter, StatusBadge } from "@/components/badges";
import { Markdown } from "@/components/markdown";
import { openDock, useChatScope } from "@/frame/store";
import { post, useApi, type CompanyDetail, type SystemInfo } from "@/lib/api";
import { ago, dateTime, host, money } from "@/lib/format";
import { Btn, Card, Chip, Dot, Empty, ErrorNote, IconBtn, Loading, Monogram, Page, Panel, Table, Td, Th, Tr, cn } from "@/ui/kit";

export function CompanyPage() {
  const { id } = useParams({ from: "/companies/$id" });
  const [poll, setPoll] = useState(false);
  const q = useApi<CompanyDetail>(["company", id], `/api/v1/companies/${id}`, { refetchInterval: poll ? 4000 : false });
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const noKey = sys.data?.llmConfigured === false;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const c = q.data;

  useChatScope(c ? { scope: "company", companyId: c.id, slug: c.slug, label: c.name } : null);

  async function research() {
    if (!c) return;
    await post(`/api/v1/companies/${c.id}/actions/research`);
    toast("Research queued");
    setPoll(true);
    setTimeout(() => setPoll(false), 3 * 60_000);
  }
  async function scan(bid: string) {
    await post(`/api/v1/radar/boards/${bid}/scan?force=1`);
    toast.success("Scan queued");
    void qc.invalidateQueries({ queryKey: ["radar"] });
  }

  if (q.isLoading) return <Page><Loading rows={6} /></Page>;
  if (q.isError) return <Page><ErrorNote error={q.error} /></Page>;
  if (!c) return <Page><Empty>Company not found.</Empty></Page>;

  const open = c.positions.filter((p) => p.status !== "archived");
  const archived = c.positions.length - open.length;
  const hot = open.filter((p) => ["review", "materials", "applied", "screen", "interview", "offer"].includes(p.status)).length;
  const meta = (c.metadata || {}) as { hqLocation?: string; sizeBand?: string; remotePolicy?: string; funding?: string };

  return (
    <Page wide>
      <div className="flex items-start gap-4 flex-wrap">
        <Monogram name={c.name} size={56} className="rounded-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[26px] leading-tight font-semibold tracking-[-0.01em]">{c.name}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] mt-1 text-muted">
            {c.website ? (
              <a href={c.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                {host(c.website)} <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            {c.careersUrl ? (
              <a href={c.careersUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                careers <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
            {meta.hqLocation ? <span>{meta.hqLocation}</span> : null}
            {meta.sizeBand ? <span>{meta.sizeBand}</span> : null}
            {meta.remotePolicy ? <span>{meta.remotePolicy}</span> : null}
          </div>
          {c.industryTags?.length ? (
            <div className="flex flex-wrap gap-1 mt-2">
              {c.industryTags.map((t) => (
                <Chip key={t} tone="faint" mono={false}>
                  {t}
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right mr-2 hidden sm:block">
            <div className="font-display text-[22px] font-semibold tabular leading-none">{open.length}</div>
            <div className="eyebrow mt-0.5">open · {hot} hot</div>
          </div>
          <Btn variant={c.research ? "default" : "primary"} disabled={noKey} title={noKey ? "Add a model key in Settings" : undefined} onClick={research}>
            <Sparkles className="h-3.5 w-3.5" /> {c.research ? "Refresh research" : "Research"}
          </Btn>
          <IconBtn label="Chat about this company" onClick={() => openDock("chat")}>
            <MessageSquareText className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>

      {c.overview ? <Card className="p-4 text-[13px] leading-relaxed max-w-4xl">{c.overview}</Card> : null}

      <div className="grid lg:grid-cols-[1fr_1fr] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          <Panel title="Positions" meta={`${open.length} open${archived ? ` · ${archived} archived` : ""}`} flush>
            {c.positions.length === 0 ? (
              <div className="p-3">
                <Empty>No positions from this company yet.</Empty>
              </div>
            ) : (
              <Table className="border-0 rounded-none">
                <thead>
                  <tr>
                    <Th>Title</Th>
                    <Th w={110}>Signal</Th>
                    <Th>Status</Th>
                    <Th right>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {[...open, ...c.positions.filter((p) => p.status === "archived")].map((p) => (
                    <Tr key={p.id} className={cn(p.status === "archived" && "opacity-50")} onClick={() => navigate({ to: "/positions/$id", params: { id: p.slug } })}>
                      <Td className="max-w-[360px]">
                        <span className="truncate block">{p.title || <span className="text-faint">Untitled</span>}</span>
                        {p.locationRaw || p.salaryMin != null || p.salaryMax != null ? (
                          <span className="truncate block text-[11px] text-faint">
                            {[p.locationRaw, money(p.salaryMin, p.salaryMax, p.salaryCurrency)].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <ScoreMeter score={p.triageScore} verdict={p.triageVerdict} />
                      </Td>
                      <Td>
                        <span className="inline-flex gap-1.5">
                          <StatusBadge status={p.status} />
                          <ListingBadge status={p.listingStatus} />
                        </span>
                      </Td>
                      <Td right mono className="text-muted">
                        {ago(p.updatedAt)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          {c.boards.length ? (
            <Panel title="Boards" meta={`${c.boards.length}`} flush>
              <div className="divide-y divide-border/60">
                {c.boards.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                    <Dot tone={b.lastError ? "bad" : b.enabled ? "good" : "faint"} />
                    <span className="font-mono">
                      {b.provider}/{b.token}
                    </span>
                    <span className="text-faint font-mono text-[11px] tabular ml-auto">scanned {ago(b.lastScannedAt)}</span>
                    <IconBtn label="Scan now" onClick={() => scan(b.id)}>
                      <Play className="h-3 w-3" />
                    </IconBtn>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}
        </div>

        <Panel title="Research" meta={c.research ? `${c.research.model} · ${dateTime(c.research.createdAt)}` : undefined} className="min-w-0">
          {!c.research ? (
            <Empty>{poll ? "Researching…" : "No research yet. Research builds a dossier from the web and the JDs we hold."}</Empty>
          ) : (
            <Markdown>{c.research.markdown || "_empty_"}</Markdown>
          )}
        </Panel>
      </div>
    </Page>
  );
}
