import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { ArrowUpRight, ExternalLink, Play, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { LaneBadge, ScoreMeter, StatusBadge } from "@/components/badges";
import { useChatScope } from "@/frame/store";
import { apiMeta, del, patch, post, qs, useApi, useApiMeta, type Board, type DeltaRow, type DiscoveryRow, type Watch } from "@/lib/api";
import { ago, dateTime, titleCase } from "@/lib/format";
import { discoveryQueuedMessage } from "@/lib/discovery-toast";
import { gateReasonLabel } from "@/lib/gate-reason";
import type { RadarSearch } from "@/router";
import { Btn, Card, Dot, Empty, IconBtn, Input, Kpi, Loading, Monogram, Page, PageHeader, Pager, Seg, Select, SortHead, Table, Tabs, Td, Th, Tr, cn, ErrorNote } from "@/ui/kit";

const PAGE_SIZE = 50;
type Tab = NonNullable<RadarSearch["tab"]>;

export function RadarPage() {
  useChatScope({ scope: "global" });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onSources = pathname.startsWith("/sources");
  const search = useSearch({ strict: false }) as RadarSearch;
  const navigate = useNavigate({ from: onSources ? "/sources" : "/discovery" });
  const tab: Tab = onSources ? (search.tab === "watches" ? "watches" : "boards") : search.tab || "discovery";
  const set = (p: Partial<RadarSearch>) => navigate({ search: (prev) => ({ ...prev, page: undefined, ...p }) });
  const hours = search.hours || 72;

  const raw = useApi<{ lanes: { lane: string; c: number }[]; boards: { total: number; enabled: number; scanned24h: number; errored: number } }>(["radar", "summary", hours], `/api/v1/radar/discovery/summary?hours=${hours}`, {
    refetchInterval: 60_000,
  });
  const summary = raw.data ? { lanes: Object.fromEntries(raw.data.lanes.map((l) => [l.lane, l.c])) as Record<string, number>, boards: raw.data.boards } : undefined;
  const seen = summary ? Object.values(summary.lanes).reduce((n, c) => n + c, 0) : 0;

  return (
    <Page wide>
      <PageHeader
        title={onSources ? "Sources" : "Discovery"}
        subtitle={onSources ? "Boards and watches the worker scans." : "Scan firehose — listings observed this window, not owned positions. Owned roles live in Pipeline."}
        actions={
          <Btn
            onClick={async () => {
              const r = await post<{ enqueued: number }>("/api/v1/radar/boards/scan-all");
              const text = discoveryQueuedMessage(r);
              if (r.enqueued > 0) toast.success(text);
              else toast.message(text);
            }}
          >
            <Play className="h-3.5 w-3.5" /> Scan due boards
          </Btn>
        }
      >
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Kpi label={`seen · ${hours >= 168 ? `${hours / 24}d` : `${hours}h`}`} value={seen} hint="listings observed" />
          <Kpi label="passed gate" value={summary?.lanes.passed ?? "—"} tone={summary?.lanes.passed ? "good" : "neutral"} hint="became positions" onClick={() => set({ tab: undefined, lane: undefined })} />
          <Kpi label="marginal" value={summary?.lanes.marginal ?? "—"} tone={summary?.lanes.marginal ? "warn" : "neutral"} hint="borderline title/geo" onClick={() => set({ tab: undefined, lane: "marginal" })} />
          <Kpi
            label="sources"
            value={summary ? `${summary.boards.enabled}/${summary.boards.total}` : "—"}
            tone={summary?.boards.errored ? "bad" : "neutral"}
            hint={summary ? `${summary.boards.scanned24h} scanned 24h${summary.boards.errored ? ` · ${summary.boards.errored} erroring` : ""}` : undefined}
            onClick={() => set({ tab: "boards" })}
          />
        </div>
      </PageHeader>

      <Tabs<Tab>
        value={tab}
        onChange={(t) => set({ tab: t === "discovery" ? undefined : t, lane: undefined, q: undefined })}
        options={
          onSources
            ? [
                { value: "boards", label: "Boards", count: summary?.boards.enabled ?? null },
                { value: "watches", label: "Watches" },
              ]
            : [
                { value: "discovery", label: "Discovery" },
                { value: "deltas", label: "Board deltas" },
              ]
        }
      />

      {tab === "discovery" ? <Discovery search={search} set={set} summary={summary} /> : null}
      {tab === "deltas" ? <Deltas /> : null}
      {tab === "boards" ? <Boards search={search} set={set} /> : null}
      {tab === "watches" ? <Watches search={search} set={set} /> : null}
    </Page>
  );
}

function HoursSelect({ value, onChange }: { value: number; onChange: (h: number) => void }) {
  return (
    <select aria-label="window" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} className="h-7 rounded-md border border-border bg-bg px-2 text-[11.5px] text-muted hover:text-fg outline-none focus:border-accent">
      <option value="24">24h</option>
      <option value="72">3d</option>
      <option value="168">7d</option>
      <option value="720">30d</option>
    </select>
  );
}

/* ---------------- Discovery ---------------- */

function Discovery({ search, set, summary }: { search: RadarSearch; set: (p: Partial<RadarSearch>) => void; summary?: { lanes: Record<string, number> } }) {
  const lane = search.lane || "passed";
  const page = search.page || 1;
  const hours = search.hours || 72;
  const [q, setQ] = useState(search.q || "");
  useEffect(() => setQ(search.q || ""), [search.q]);
  const qc = useQueryClient();

  const list = useApiMeta<DiscoveryRow[]>(["radar", "discovery", lane, page, hours, search.q, search.sort], `/api/v1/radar/discovery${qs({ lane: lane === "all" ? undefined : lane, page, pageSize: PAGE_SIZE, hours, q: search.q, sort: search.sort || "observed_desc" })}`, {
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.data || [];
  const total = Number(list.data?.meta.total || 0);

  const navigate = useNavigate();
  async function promote(r: DiscoveryRow) {
    try {
      const res = await apiMeta<{ id: string; slug: string }>(`/api/v1/radar/discovery/${r.id}/promote`, { method: "POST" });
      const revived = Boolean(res.meta.revived);
      toast.success(res.meta.created ? "Promoted — triage queued" : revived ? "Revived — back in the pipeline" : "Already in the pipeline");
      void qc.invalidateQueries({ queryKey: ["radar"] });
      void qc.invalidateQueries({ queryKey: ["positions"] });
      const slug = res.data?.slug;
      if (slug) void navigate({ to: "/positions/$id", params: { id: slug } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Seg<string>
          value={lane}
          onChange={(l) => set({ lane: l === "passed" ? undefined : l })}
          options={[
            { value: "passed", label: "Passed gate", count: summary?.lanes.passed ?? null, tone: "good" },
            { value: "marginal", label: "Marginal", count: summary?.lanes.marginal ?? null, tone: "warn" },
            { value: "filtered", label: "Filtered", count: summary?.lanes.filtered ?? null },
            { value: "all", label: "All" },
          ]}
        />
        <HoursSelect value={hours} onChange={(h) => set({ hours: h })} />
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: q.trim() || undefined });
          }}
        >
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, company…" className="w-[200px] h-7 rounded-md border border-border bg-bg pl-7 pr-2 text-[12px] outline-none focus:border-accent placeholder:text-faint" />
        </form>
        <span className="ml-auto text-[11px] text-faint font-mono tabular">{total} rows</span>
      </div>

      {list.isLoading ? (
        <Loading rows={8} />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : rows.length === 0 ? (
        <Empty>{lane === "passed" ? "Nothing passed the gate in this window." : "Nothing here."}</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th w={44} />
              <Th>
                <SortHead label="Listing" field="title" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>
                <SortHead label="Location" field="location" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>{lane === "filtered" ? "Gate reason" : "Craft"}</Th>
              <Th>In pipeline</Th>
              <Th right>
                <SortHead label="Seen" field="observed" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th w={110} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="pr-0">
                  <Monogram name={r.company || "?"} size={24} />
                </Td>
                <Td className="max-w-[440px]">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{r.title}</span>
                    <span className="text-muted text-[12px] truncate shrink-0 max-w-[40%]">{r.company}</span>
                    {lane === "all" ? <LaneBadge lane={r.lane} /> : null}
                  </div>
                </Td>
                <Td className="max-w-[200px] text-muted">
                  <div className="truncate">{r.locationRaw || "—"}</div>
                </Td>
                <Td className={cn(lane === "filtered" || r.lane === "filtered" ? "text-faint" : "text-muted")}>
                  {lane === "filtered" || r.lane === "filtered" ? <span title={r.gateReason || undefined}>{gateReasonLabel(r.gateReason)}</span> : titleCase(r.craftFamily) || "—"}
                </Td>
                <Td>
                  {r.positionSlug ? (
                    <Link to="/positions/$id" params={{ id: r.positionSlug }} className="flex items-center gap-2">
                      <ScoreMeter score={r.triageScore} verdict={r.triageVerdict} />
                      {r.positionStatus ? <StatusBadge status={r.positionStatus} /> : null}
                    </Link>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </Td>
                <Td right mono className="text-muted">
                  {ago(r.observedAt)}
                </Td>
                <Td right>
                  <span className="inline-flex items-center gap-1">
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer" className="text-faint hover:text-fg inline-flex h-7 w-7 items-center justify-center" aria-label="Open listing">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : null}
                    {!r.positionSlug || r.positionStatus === "archived" ? (
                      <Btn size="xs" variant="ghost" onClick={() => promote(r)} title={r.positionStatus === "archived" ? "Revive archived position" : "Create a position and run triage"}>
                        <ArrowUpRight className="h-3 w-3" /> {r.positionStatus === "archived" ? "Revive" : "Promote"}
                      </Btn>
                    ) : null}
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {total > PAGE_SIZE ? <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={(p) => set({ page: p > 1 ? p : undefined })} /> : null}
    </div>
  );
}

/* ---------------- Deltas ---------------- */

function Deltas() {
  const [hours, setHours] = useState(72);
  const [event, setEvent] = useState("");
  const q = useApi<DeltaRow[]>(["radar", "deltas", hours, event], `/api/v1/radar/deltas${qs({ hours, event, limit: 300 })}`);
  const rows = q.data || [];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Seg<string>
          value={event}
          onChange={setEvent}
          options={[
            { value: "", label: "All" },
            { value: "new", label: "New", tone: "good" },
            { value: "changed", label: "Changed", tone: "warn" },
            { value: "closed", label: "Closed", tone: "bad" },
          ]}
        />
        <HoursSelect value={hours} onChange={setHours} />
        <span className="text-[11px] text-faint font-mono ml-auto tabular">{rows.length} events</span>
      </div>
      {q.isLoading ? (
        <Loading rows={8} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : rows.length === 0 ? (
        <Empty>No board deltas in this window.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th w={90}>Event</Th>
              <Th>Listing</Th>
              <Th>Location</Th>
              <Th right>When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td>
                  <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px]", r.event === "closed" ? "text-bad" : r.event === "new" ? "text-good" : "text-warn")}>
                    <Dot tone={r.event === "closed" ? "bad" : r.event === "new" ? "good" : "warn"} />
                    {r.event}
                  </span>
                </Td>
                <Td className="max-w-[480px]">
                  <div className="truncate flex items-center gap-2">
                    {r.url ? (
                      <a href={r.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                        {r.title}
                      </a>
                    ) : (
                      <span className="truncate">{r.title}</span>
                    )}
                    <span className="text-muted text-[12px] shrink-0">{r.company}</span>
                  </div>
                </Td>
                <Td className="text-muted max-w-[200px]">
                  <div className="truncate">{r.locationRaw || "—"}</div>
                </Td>
                <Td right mono className="text-muted">
                  {ago(r.observedAt)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/* ---------------- Boards (sources) ---------------- */

function Boards({ search, set }: { search: RadarSearch; set: (p: Partial<RadarSearch>) => void }) {
  const [q, setQ] = useState(search.q || "");
  const [enabled, setEnabled] = useState<"true" | "false" | "">("true");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ company: "", provider: "greenhouse", token: "" });
  const qc = useQueryClient();
  const list = useApi<Board[]>(["radar", "boards", search.q, enabled, search.sort], `/api/v1/radar/boards${qs({ q: search.q, enabled, sort: search.sort })}`);
  const rows = list.data || [];

  async function toggle(b: Board) {
    await patch(`/api/v1/radar/boards/${b.id}`, { enabled: !b.enabled });
    void qc.invalidateQueries({ queryKey: ["radar", "boards"] });
  }
  async function scan(b: Board) {
    await post(`/api/v1/radar/boards/${b.id}/scan?force=1`);
    toast.success(`Scan queued: ${b.company}`);
  }
  async function add() {
    try {
      await post("/api/v1/radar/boards", form);
      toast.success("Board added");
      setAdding(false);
      setForm({ company: "", provider: "greenhouse", token: "" });
      void qc.invalidateQueries({ queryKey: ["radar"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: q.trim() || undefined });
          }}
        >
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company, token…" className="w-[200px] h-7 rounded-md border border-border bg-bg pl-7 pr-2 text-[12px] outline-none focus:border-accent placeholder:text-faint" />
        </form>
        <Seg<"true" | "false" | "">
          value={enabled}
          onChange={setEnabled}
          options={[
            { value: "true", label: "Enabled" },
            { value: "false", label: "Disabled" },
            { value: "", label: "All" },
          ]}
        />
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-faint font-mono tabular">{rows.length} boards</span>
          <Btn onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Board
          </Btn>
        </span>
      </div>
      {adding ? (
        <Card className="p-3 grid sm:grid-cols-[1fr_140px_1fr_auto] gap-2 items-end">
          <Input label="Company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          <Select label="Provider" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="greenhouse">greenhouse</option>
            <option value="ashby">ashby</option>
            <option value="lever">lever</option>
          </Select>
          <Input label="Board token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="e.g. grafanalabs" />
          <Btn variant="primary" size="md" onClick={add} disabled={!form.company || !form.token}>
            Add
          </Btn>
        </Card>
      ) : null}
      {list.isLoading ? (
        <Loading rows={8} />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th w={30} />
              <Th>
                <SortHead label="Company" field="company" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>
                <SortHead label="Provider" field="provider" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>
                <SortHead label="Token" field="token" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th right>
                <SortHead label="Last scan" field="last_scanned" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>Error</Th>
              <Th w={120} />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <Tr key={b.id} className={b.enabled ? "" : "opacity-50"}>
                <Td className="pr-0">
                  <Dot tone={b.errorKind === "transient" ? "warn" : b.lastError ? "bad" : b.enabled ? "good" : "faint"} />
                </Td>
                <Td className="font-medium">{b.company}</Td>
                <Td mono className="text-muted">
                  {b.provider}
                </Td>
                <Td mono className="text-muted">
                  {b.token}
                </Td>
                <Td right mono className="text-muted">
                  {ago(b.lastScannedAt)}
                </Td>
                <Td className="max-w-[260px] text-bad text-[11px]">
                  {b.lastError ? <div className={b.errorKind === "transient" ? "text-warn" : "text-bad"}>{b.errorKind === "transient" ? "Temporary failure" : b.errorKind === "missing" ? "Board not found" : b.errorKind === "auth" ? "Access denied" : "Unclassified error"}</div> : null}
                  <div className="truncate" title={b.lastError || ""}>
                    {b.lastError || ""}
                  </div>
                </Td>
                <Td right>
                  <span className="inline-flex gap-1">
                    <IconBtn label="Scan now" onClick={() => scan(b)}>
                      <Play className="h-3.5 w-3.5" />
                    </IconBtn>
                    <Btn size="xs" variant="ghost" onClick={() => toggle(b)}>
                      {b.enabled ? "Disable" : "Enable"}
                    </Btn>
                  </span>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

/* ---------------- Watches ---------------- */

function Watches({ search, set }: { search: RadarSearch; set: (p: Partial<RadarSearch>) => void }) {
  const qc = useQueryClient();
  const q = useApi<Watch[]>(["radar", "watches", search.sort], `/api/v1/radar/watches${qs({ sort: search.sort })}`);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const rows = q.data || [];
  async function add() {
    try {
      await post("/api/v1/radar/watches", { url, label: label || undefined });
      setUrl("");
      setLabel("");
      void qc.invalidateQueries({ queryKey: ["radar", "watches"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }
  async function remove(w: Watch) {
    await del(`/api/v1/radar/watches/${w.id}`);
    void qc.invalidateQueries({ queryKey: ["radar", "watches"] });
  }
  return (
    <div className="space-y-3">
      <Card className="p-3 grid sm:grid-cols-[1fr_200px_auto] gap-2 items-end">
        <Input label="URL to watch" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Any careers page or job URL" />
        <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Btn variant="primary" size="md" onClick={add} disabled={!url}>
          Watch
        </Btn>
      </Card>
      <p className="text-[11.5px] text-muted">Positions with the eye icon are watched too. This list is for URLs that are not a tracked position.</p>
      {q.isLoading ? (
        <Loading rows={4} />
      ) : rows.length === 0 ? (
        <Empty>No standalone watches.</Empty>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>
                <SortHead label="Label" field="label" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>
                <SortHead label="URL" field="url" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th>Listing</Th>
              <Th right>
                <SortHead label="Checked" field="checked" sort={search.sort} onSort={(n) => set({ sort: n })} />
              </Th>
              <Th right>Changed</Th>
              <Th w={40} />
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <Tr key={w.id}>
                <Td>{w.label || "—"}</Td>
                <Td className="max-w-[400px]">
                  <a href={w.url} target="_blank" rel="noreferrer" className="truncate block hover:underline">
                    {w.url}
                  </a>
                </Td>
                <Td mono className="text-muted">
                  {w.listingStatus || "—"}
                </Td>
                <Td right mono className="text-muted">
                  {ago(w.lastCheckedAt)}
                </Td>
                <Td right mono className="text-muted">
                  {w.lastChangedAt ? dateTime(w.lastChangedAt) : "—"}
                </Td>
                <Td right>
                  <IconBtn label="Remove watch" onClick={() => remove(w)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
