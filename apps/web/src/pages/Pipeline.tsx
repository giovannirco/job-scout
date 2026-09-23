import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ExternalLink, Eye, LayoutGrid, List, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GeoChip, ListingBadge, ScoreMeter, STATUS_LABEL, STATUS_PATH, STATUS_TONE, WorkplaceChip } from "@/components/badges";
import { StatusMenu, useStatusChange } from "@/components/status-menu";
import { useChatScope } from "@/frame/store";
import { qs, STATUSES, useApi, useApiMeta, type PipelineStatus, type PositionRow, type Profile, type SystemInfo } from "@/lib/api";
import { homeMarket } from "@job-scout/shared";
import { defaultPipelinePreset, pipelineSortFallback, pipelineSortOptions } from "./pipeline-defaults";
import { familyLocationLabel } from "./pipeline-location";
import { ago, departmentLabel, jdChangedAt, money } from "@/lib/format";
import { archiveReasonLabel } from "@/lib/gate-reason";
import type { PipelineSearch } from "@/router";
import { Btn, Card, Dot, Empty, Loading, Monogram, Page, PageHeader, Pager, Seg, SortHead, Table, Td, Th, Tr, cn, ErrorNote } from "@/ui/kit";

const PAGE_SIZE = 50;

type Preset = "decide" | "marginal" | "active" | "all" | "archived";
const PRESETS: { value: Preset; label: string; params: Partial<PipelineSearch> }[] = [
  { value: "decide", label: "Decide", params: { verdict: "pass", status: "triaged,review", sort: "score_desc" } },
  { value: "marginal", label: "Marginal", params: { verdict: "marginal", status: "triaged", sort: "score_desc" } },
  { value: "active", label: "Active", params: { status: "hot", sort: "updated_desc" } },
  { value: "all", label: "All open", params: { status: "active", sort: "posted_desc" } },
  { value: "archived", label: "Archived", params: { status: "archived", sort: "updated_desc" } },
];

function presetOf(s: PipelineSearch): Preset | null {
  for (const p of PRESETS) if ((p.params.verdict || undefined) === s.verdict && (p.params.status || undefined) === s.status) return p.value;
  return null;
}

export function PipelinePage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/pipeline" });
  const navigate = useNavigate({ from: "/pipeline" });
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const profile = useApi<Profile>(["profile"], "/api/v1/settings/profile", { staleTime: 30_000 });
  const untouched = !search.status && !search.verdict && !search.q && !search.company;
  const llmKnown = sys.isError || sys.data !== undefined;
  const presetReady = !untouched || llmKnown;
  const opening = defaultPipelinePreset(sys.data?.llmConfigured === true);
  const s: PipelineSearch = untouched
    ? { ...PRESETS.find((p) => p.value === opening)!.params, ...stripUndefined(search) }
    : { sort: pipelineSortFallback(search), ...stripUndefined(search) };
  const page = s.page || 1;
  const [q, setQ] = useState(s.q || "");
  useEffect(() => setQ(s.q || ""), [s.q]);

  const set = (patch: Partial<PipelineSearch>) => navigate({ search: (prev) => ({ ...prev, page: undefined, ...patch }) });

  const list = useApiMeta<PositionRow[]>(
    ["positions", "list", s],
    `/api/v1/positions${qs({ page, pageSize: s.view === "board" ? 200 : PAGE_SIZE, status: s.status, verdict: s.verdict, sort: s.sort, q: s.q, company: s.company, workplace: s.workplace, geoClass: s.geoClass, actionable: ["decide", "marginal"].includes(presetOf(s) || "") ? "true" : undefined, collapseFamilies: "true", includeArchived: s.status === "archived" ? "true" : undefined })}`,
    { placeholderData: (prev) => prev, enabled: presetReady },
  );
  const rows = list.data?.data || [];
  const total = Number(list.data?.meta.total || 0);
  const preset = presetOf(s);

  return (
    <Page wide>
      <PageHeader
        title="Pipeline"
        subtitle={`Owned positions. Discovery is the scan firehose. ${total} ${total === 1 ? "position" : "positions"}${s.company ? ` at ${s.company}` : ""}`}
        actions={
          <>
            <form
              className="relative"
              onSubmit={(e) => {
                e.preventDefault();
                void set({ q: q.trim() || undefined });
              }}
            >
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, company, team, location…" className="w-[260px] h-8 rounded-md border border-border bg-bg pl-7 pr-7 text-[12.5px] outline-none focus:border-accent placeholder:text-faint" />
              {q ? (
                <button type="button" onClick={() => (setQ(""), set({ q: undefined }))} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-faint hover:text-fg" aria-label="Clear search">
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </form>
            <Seg<"table" | "board">
              value={s.view || "table"}
              onChange={(v) => set({ view: v === "board" ? "board" : undefined })}
              options={[
                { value: "table", label: <List className="h-3.5 w-3.5" /> },
                { value: "board", label: <LayoutGrid className="h-3.5 w-3.5" /> },
              ]}
            />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Seg<Preset | "custom">
            value={preset || "custom"}
            onChange={(v) => {
              const p = PRESETS.find((x) => x.value === v);
              if (p) void set({ verdict: p.params.verdict, status: p.params.status, sort: p.params.sort, view: s.view });
            }}
            options={[...PRESETS.map((p) => ({ value: p.value, label: p.label })), ...(preset ? [] : [{ value: "custom" as const, label: "Custom" }])]}
          />
          <FilterSelect value={s.status || ""} onChange={(v) => set({ status: v || undefined })} label="status">
            <option value="">any status</option>
            <option value="hot">active (review → offer)</option>
            <option value="active">all but archived</option>
            {STATUSES.map((st) => (
              <option key={st} value={st}>
                {STATUS_LABEL[st]}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect value={s.verdict || ""} onChange={(v) => set({ verdict: v || undefined })} label="verdict">
            <option value="">any verdict</option>
            <option value="pass">pass</option>
            <option value="marginal">marginal</option>
            <option value="pass,marginal">pass + marginal</option>
            <option value="fail">fail</option>
            <option value="none">not scored</option>
          </FilterSelect>
          <FilterSelect value={s.workplace || ""} onChange={(v) => set({ workplace: v || undefined })} label="workplace">
            <option value="">any workplace</option>
            <option value="remote">remote</option>
            <option value="hybrid">hybrid</option>
            <option value="onsite">onsite</option>
            <option value="unknown">unknown</option>
          </FilterSelect>
          <FilterSelect value={s.geoClass || ""} onChange={(v) => set({ geoClass: v || undefined })} label="geo">
            <option value="">any geo</option>
            <option value="worldwideish">worldwide</option>
            <option value="brazil_friendly">brazil / latam</option>
            <option value="ambiguous_remote">ambiguous remote</option>
            {homeMarket(profile.data?.location || "") ? <option value="home">home</option> : null}
            <option value="hard_geo">hard geo</option>
            <option value="unknown">unknown</option>
          </FilterSelect>
          <FilterSelect value={s.sort || "updated_desc"} onChange={(v) => set({ sort: v })} label="sort">
            {pipelineSortOptions(s.sort).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </FilterSelect>
          {s.company ? (
            <Btn variant="ghost" size="xs" onClick={() => set({ company: undefined })}>
              company: {s.company} <X className="h-3 w-3" />
            </Btn>
          ) : null}
        </div>
      </PageHeader>

      {!presetReady || list.isLoading ? (
        <Loading rows={8} />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : rows.length === 0 ? (
        <Empty>
          {preset === "decide" ? (
            sys.data && !sys.data.llmConfigured ? (
              <>
                No model key is set, so nothing has a PASS verdict.{" "}
                <button type="button" className="text-accent hover:underline" onClick={() => set({ verdict: undefined, status: "active", sort: "posted_desc" })}>
                  Show all open filings
                </button>
                .
              </>
            ) : (
              "No PASS verdicts waiting. Nothing to decide."
            )
          ) : (
            "Nothing matches these filters."
          )}
        </Empty>
      ) : s.view === "board" ? (
        <Board rows={rows} />
      ) : (
        <PositionsTable rows={rows} home={profile.data?.location} sort={s.sort} />
      )}
      {total > PAGE_SIZE && s.view !== "board" ? <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={(p) => navigate({ search: (prev) => ({ ...prev, page: p > 1 ? p : undefined }) })} /> : null}
    </Page>
  );
}

function FilterSelect({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="h-7 rounded-md border border-border bg-bg px-2 text-[11.5px] text-muted hover:text-fg outline-none focus:border-accent">
      {children}
    </select>
  );
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function PositionsTable({ rows, home, sort }: { rows: PositionRow[]; home?: string | null; sort?: string }) {
  const navigate = useNavigate({ from: "/pipeline" });
  const [cursor, setCursor] = useState<number>(-1);
  function sortTo(next: string) {
    void navigate({ search: (prev) => ({ ...prev, sort: next, page: undefined }) });
  }

  // j / k / enter navigate the list; o opens the posting
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.metaKey || e.ctrlKey) return;
      if (e.key === "j") setCursor((c) => Math.min(rows.length - 1, c + 1));
      else if (e.key === "k") setCursor((c) => Math.max(0, c - 1));
      else if (e.key === "Enter" && cursor >= 0 && rows[cursor]) void navigate({ to: "/positions/$id", params: { id: rows[cursor]!.slug } });
      else if (e.key === "o" && cursor >= 0 && rows[cursor]?.primaryUrl) window.open(rows[cursor]!.primaryUrl!, "_blank", "noreferrer");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, cursor, navigate]);

  return (
    <Table>
      <thead>
        <tr>
          <Th w={44} />
          <Th>
            <SortHead label="Position" field="title" sort={sort} onSort={sortTo} />
          </Th>
          <Th w={120}>
            <SortHead label="Signal" field="score" sort={sort} onSort={sortTo} />
          </Th>
          <Th>
            <SortHead label="Workplace" field="workplace" sort={sort} onSort={sortTo} />
          </Th>
          <Th>
            <SortHead label="Location" field="location" sort={sort} onSort={sortTo} />
          </Th>
          <Th>
            <SortHead label="Geo" field="geo" sort={sort} onSort={sortTo} />
          </Th>
          <Th>Comp</Th>
          <Th>
            <SortHead label="Status" field="status" sort={sort} onSort={sortTo} />
          </Th>
          <Th right>
            <SortHead label="Posted" field="posted" sort={sort} onSort={sortTo} />
          </Th>
          <Th right>
            <SortHead label="First seen" field="first_seen" sort={sort} onSort={sortTo} />
          </Th>
          <Th right>
            <SortHead label="Changed" field="last_changed" sort={sort} onSort={sortTo} />
          </Th>
          <Th w={36} />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const loc = familyLocationLabel(r.locations, r.locationRaw);
          return (
          <Tr key={r.id} selected={i === cursor} onClick={() => navigate({ to: "/positions/$id", params: { id: r.slug } })}>
            <Td className="pr-0">
              <Monogram name={r.company.name} size={26} />
            </Td>
            <Td className="max-w-[520px]">
              <div className="flex items-center gap-2 min-w-0">
                <Link to="/positions/$id" params={{ id: r.slug }} onClick={(e) => e.stopPropagation()} className="truncate font-medium text-[13px] hover:underline decoration-border-strong underline-offset-2">
                  {r.title}
                </Link>
                <Link to="/companies/$id" params={{ id: r.company.slug }} onClick={(e) => e.stopPropagation()} className="text-muted hover:text-fg text-[12px] truncate shrink-0 max-w-[36%]">
                  {r.company.name}
                </Link>
              </div>
              {departmentLabel(r.departments) ? <div className="text-[11px] text-faint truncate">{departmentLabel(r.departments)}</div> : null}
              {r.triageOneLiner ? <div className="text-[11.5px] text-muted truncate">{r.triageOneLiner}</div> : null}
              {r.status === "archived" && r.archiveReason ? <div className="text-[11px] text-faint truncate" title={r.archiveReason}>{archiveReasonLabel(r.archiveReason)}</div> : null}
              {(r.siblingCount || 0) > 1 ? <div className="text-[11px] text-muted">{new Set((r.locations || []).filter(Boolean)).size <= 1 ? `${r.siblingCount} copies of this posting` : `${r.siblingCount} related postings`}</div> : null}
              {r.repostOfId ? <div className="text-[11px] text-amber-500">Possible repost · prior {r.repost?.status || "history"}</div> : null}
            </Td>
            <Td>
              <ScoreMeter score={r.triageScore} verdict={r.triageVerdict} />
              {r.triageStale ? <span className="text-[10px] text-muted" title="Scored before the current profile, or profile version unknown">Profile changed</span> : null}
            </Td>
            <Td>
              <WorkplaceChip workplace={r.workplace} />
            </Td>
            <Td className="max-w-[220px]">
              <div className="truncate text-[12px]" title={loc?.title}>
                {loc ? loc.text : <span className="text-faint">—</span>}
              </div>
            </Td>
            <Td>
              <GeoChip geo={r.geoClass} location={r.locationRaw} home={home} />
            </Td>
            <Td mono title={r.familySalarySpan ? "Lowest to highest posted band across the related locations" : undefined}>{money(r.salaryMin, r.salaryMax, r.salaryCurrency) || <span className="text-faint">—</span>}</Td>
            <Td>
              <div className="flex items-center gap-1.5">
                <StatusMenu id={r.id} value={r.status} />
                <ListingBadge status={r.listingStatus} />
                {r.watchEnabled ? <Eye className="h-3 w-3 text-faint" aria-label="watched" /> : null}
              </div>
            </Td>
            <Td right mono className="text-muted" title={r.postedAt || undefined}>
              {r.postedAt ? ago(r.postedAt) : <span className="text-faint">—</span>}
            </Td>
            <Td right mono className="text-muted">
              {r.firstSeenAt ? ago(r.firstSeenAt) : <span className="text-faint">—</span>}
            </Td>
            <Td right mono className="text-muted">
              {jdChangedAt(r.firstSeenAt, r.lastChangedAt) ? ago(r.lastChangedAt) : <span className="text-faint">—</span>}
            </Td>
            <Td>
              {r.primaryUrl ? (
                <a href={r.primaryUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-faint hover:text-fg inline-flex" aria-label="Open posting">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </Td>
          </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function Board({ rows }: { rows: PositionRow[] }) {
  const m = useStatusChange();
  const [drag, setDrag] = useState<string | null>(null);
  const cols = STATUS_PATH.filter((c) => rows.some((r) => r.status === c) || ["review", "materials", "applied", "interview"].includes(c));
  return (
    <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
      {cols.map((col) => {
        const items = rows.filter((r) => r.status === col);
        return (
          <div
            key={col}
            className="w-[260px] shrink-0 flex flex-col rounded-lg bg-surface-2/40 border border-border/60"
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (!drag) return;
              const r = rows.find((x) => x.id === drag);
              if (r && r.status !== col) m.mutateAsync({ id: drag, status: col }).then(() => toast.success(`Moved to ${STATUS_LABEL[col]}`)).catch(e => toast.error(e instanceof Error ? e.message : "Move failed"));
              setDrag(null);
            }}
          >
            <div className="flex items-center gap-2 px-2.5 h-9">
              <Dot tone={STATUS_TONE[col as PipelineStatus]} />
              <span className="text-[12px] font-medium">{STATUS_LABEL[col as PipelineStatus]}</span>
              <span className="ml-auto font-mono text-[10.5px] text-faint tabular">{items.length}</span>
            </div>
            <div className="px-1.5 pb-1.5 space-y-1.5 min-h-[60px]">
              {items.map((r) => (
                <Card key={r.id} className={cn("p-2.5 cursor-grab hover:border-border-strong", drag === r.id && "opacity-40")}>
                  <div draggable onDragStart={() => setDrag(r.id)} onDragEnd={() => setDrag(null)}>
                    <Link to="/positions/$id" params={{ id: r.slug }} className="block">
                      <div className="flex items-center gap-2 mb-1">
                        <Monogram name={r.company.name} size={18} />
                        <span className="text-[11px] text-muted truncate">{r.company.name}</span>
                      </div>
                      <div className="text-[12.5px] leading-snug line-clamp-2">{r.title}</div>
                      {departmentLabel(r.departments) ? <div className="text-[11px] text-faint truncate mt-0.5">{departmentLabel(r.departments)}</div> : null}
                      {r.locationRaw ? <div className="text-[11px] text-muted truncate mt-1">{r.locationRaw}</div> : null}
                      {money(r.salaryMin, r.salaryMax, r.salaryCurrency) ? <div className="text-[11px] font-mono text-fg truncate mt-1">{money(r.salaryMin, r.salaryMax, r.salaryCurrency)}</div> : null}
                      {r.postedAt || r.firstSeenAt ? (
                        <div className="text-[10.5px] font-mono text-faint tabular mt-1">
                          {r.postedAt ? `posted ${ago(r.postedAt)}` : ""}
                          {r.postedAt && r.firstSeenAt ? " · " : ""}
                          {r.firstSeenAt ? `seen ${ago(r.firstSeenAt)}` : ""}
                        </div>
                      ) : null}
                    </Link>
                    <div className="flex items-center justify-between mt-2">
                      <ScoreMeter score={r.triageScore} verdict={r.triageVerdict} />
                      {jdChangedAt(r.firstSeenAt, r.lastChangedAt) ? <span className="text-[10.5px] font-mono text-faint tabular">changed {ago(r.lastChangedAt)}</span> : null}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
