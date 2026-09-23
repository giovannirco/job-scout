import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { InboxPanel } from "@/frame/Dock";
import { useChatScope } from "@/frame/store";
import { useApi, type Approval, type AutopilotState } from "@/lib/api";
import { ago } from "@/lib/format";
import { Btn, Loading, Page, PageHeader, Seg, SortHead, cn, ErrorNote } from "@/ui/kit";

type Filter = "pending" | "approved" | "dismissed" | "all";

export function InboxPage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/inbox" });
  const navigate = useNavigate({ from: "/inbox" });
  const filter = (search.status as Filter) || "pending";
  const setFilter = (status: Filter) => navigate({ search: (prev) => ({ ...prev, status: status === "pending" ? undefined : status }) });
  const q = useApi<Approval[]>(["approvals", filter, search.sort], `/api/v1/approvals?status=${filter}&limit=100${search.sort ? `&sort=${search.sort}` : ""}`, { refetchInterval: 30_000 });
  const auto = useApi<AutopilotState>(["autopilot"], "/api/v1/settings/autopilot");
  const items = q.data || [];

  return (
    <Page>
      <PageHeader
        title="Inbox"
        subtitle="Everything autopilot wants to do but will not do without you."
        actions={
          <Link to="/settings" search={{ tab: "autopilot" }}>
            <Btn variant="outline">
              Autopilot: <span className={cn("capitalize", auto.data?.preset === "manual" ? "text-faint" : "text-accent")}>{auto.data?.preset ?? "…"}</span>
            </Btn>
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Seg<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: "pending", label: "Pending", count: filter === "pending" ? items.length : auto.data?.summary.pendingApprovals ?? null, tone: "accent" },
              { value: "approved", label: "Approved" },
              { value: "dismissed", label: "Dismissed" },
              { value: "all", label: "All" },
            ]}
          />
          <div className="flex items-center gap-2 text-[11.5px] text-muted">
            <SortHead label="Created" field="created" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n }) })} />
            <SortHead label="Title" field="title" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n }) })} />
            <SortHead label="Status" field="status" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n }) })} />
          </div>
        </div>
      </PageHeader>
      {q.isLoading ? (
        <Loading rows={4} />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : filter === "pending" ? (
        <InboxPanel items={items} full />
      ) : (
        <div className="rounded-lg border border-border bg-surface divide-y divide-border/60">
          {items.length === 0 ? <div className="p-4 text-[12.5px] text-faint">Nothing here.</div> : null}
          {items.map((a) => (
            <div key={a.id} className="px-3 py-2 flex items-center gap-3 text-[12.5px]">
              <span className={cn("font-mono text-[10.5px] uppercase w-16 shrink-0", a.status === "approved" ? "text-good" : "text-faint")}>{a.status}</span>
              <span className="truncate flex-1">{a.title}</span>
              {a.position ? (
                <Link to="/positions/$id" params={{ id: a.position.slug }} className="text-muted hover:text-fg truncate max-w-[40%]">
                  {a.position.company} · {a.position.title}
                </Link>
              ) : null}
              <span className="font-mono text-[10.5px] text-faint tabular shrink-0">{ago(a.resolvedAt || a.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Page>
  );
}
