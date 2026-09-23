import { useNavigate, useSearch } from "@tanstack/react-router";
import { LayoutGrid, List, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useChatScope } from "@/frame/store";
import { qs, useApiMeta, type CompanyRow } from "@/lib/api";
import { ago, countLabel, host } from "@/lib/format";
import { Card, Empty, ErrorNote, Loading, Monogram, Page, PageHeader, Pager, Seg, SortHead, Table, Td, Th, Tr, cn } from "@/ui/kit";

const PAGE_SIZE = 50;

export function CompaniesPage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/companies" });
  const navigate = useNavigate({ from: "/companies" });
  const page = search.page || 1;
  const [q, setQ] = useState(search.q || "");
  const [view, setView] = useState<"grid" | "table">(() => (localStorage.getItem("js_companies_view") as "grid" | "table") || "grid");
  useEffect(() => setQ(search.q || ""), [search.q]);
  useEffect(() => localStorage.setItem("js_companies_view", view), [view]);

  const list = useApiMeta<CompanyRow[]>(["companies", search.q, page, search.all, search.sort], `/api/v1/companies${qs({ q: search.q, page, pageSize: PAGE_SIZE, withPositions: search.all ? undefined : "true", sort: search.sort })}`, {
    placeholderData: (prev) => prev,
  });
  const rows = list.data?.data || [];
  const total = Number(list.data?.meta.total || 0);

  return (
    <Page wide>
      <PageHeader
        title="Companies"
        subtitle={search.all ? `${countLabel(total, "company", "companies")} known` : `${countLabel(total, "company", "companies")} with an open role`}
        actions={
          <>
            <form
              className="relative"
              onSubmit={(e) => {
                e.preventDefault();
                void navigate({ search: { q: q.trim() || undefined, all: search.all } });
              }}
            >
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name…" className="w-[200px] h-8 rounded-md border border-border bg-bg pl-7 pr-2 text-[12.5px] outline-none focus:border-accent placeholder:text-faint" />
            </form>
            <Seg<"positions" | "all">
              value={search.all ? "all" : "positions"}
              onChange={(v) => navigate({ search: { q: search.q, all: v === "all" ? true : undefined } })}
              options={[
                { value: "positions", label: "Open roles" },
                { value: "all", label: "All" },
              ]}
            />
            <Seg<"grid" | "table">
              value={view}
              onChange={setView}
              options={[
                { value: "grid", label: <LayoutGrid className="h-3.5 w-3.5" /> },
                { value: "table", label: <List className="h-3.5 w-3.5" /> },
              ]}
            />
          </>
        }
      />
      {list.isLoading ? (
        <Loading rows={6} />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : rows.length === 0 ? (
        <Empty>No companies match.</Empty>
      ) : view === "grid" ? (
        <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(230px,1fr))]">
          {rows.map((c) => (
            <Card key={c.id} className="p-3 flex flex-col gap-2.5" onClick={() => navigate({ to: "/companies/$id", params: { id: c.slug } })}>
              <div className="flex items-center gap-2.5 min-w-0">
                <Monogram name={c.name} size={32} />
                <div className="min-w-0">
                  <div className="font-medium text-[13px] truncate">{c.name}</div>
                  <div className="text-[11px] text-muted truncate">{host(c.website) || host(c.careersUrl) || "—"}</div>
                </div>
              </div>
              {c.industryTags?.length ? <div className="text-[10.5px] font-mono text-faint truncate">{c.industryTags.slice(0, 3).join(" · ")}</div> : <div className="h-[15px]" />}
              <div className="grid grid-cols-3 gap-1 pt-2 border-t border-border/70 text-center">
                <Stat label="hot" v={c.positionsHot} tone={c.positionsHot ? "text-good" : "text-faint"} />
                <Stat label="pass" v={c.positionsPass} tone={c.positionsPass ? "text-fg" : "text-faint"} />
                <Stat label="open" v={c.positionsOpen} tone="text-muted" />
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>
                <SortHead label="Company" field="name" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, page: undefined }) })} />
              </Th>
              <Th>Site</Th>
              <Th>Tags</Th>
              <Th right>
                <SortHead label="Hot" field="hot" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, page: undefined }) })} />
              </Th>
              <Th right>
                <SortHead label="Pass" field="pass" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, page: undefined }) })} />
              </Th>
              <Th right>
                <SortHead label="Open" field="open" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, page: undefined }) })} />
              </Th>
              <Th right>
                <SortHead label="Updated" field="updated" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, page: undefined }) })} />
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <Tr key={c.id} onClick={() => navigate({ to: "/companies/$id", params: { id: c.slug } })}>
                <Td className="font-medium">
                  <span className="inline-flex items-center gap-2">
                    <Monogram name={c.name} size={22} />
                    {c.name}
                  </span>
                </Td>
                <Td className="text-muted">{host(c.website) || host(c.careersUrl) || "—"}</Td>
                <Td className="text-faint font-mono text-[11px] max-w-[260px]">
                  <div className="truncate">{c.industryTags?.join(" · ") || ""}</div>
                </Td>
                <Td right mono className={c.positionsHot ? "text-good" : "text-faint"}>
                  {c.positionsHot}
                </Td>
                <Td right mono className={c.positionsPass ? "text-fg" : "text-faint"}>
                  {c.positionsPass}
                </Td>
                <Td right mono className="text-muted">
                  {c.positionsOpen}
                </Td>
                <Td right mono className="text-muted">
                  {ago(c.updatedAt)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {total > PAGE_SIZE ? <Pager page={page} pageSize={PAGE_SIZE} total={total} onPage={(p) => navigate({ search: (prev) => ({ ...prev, page: p > 1 ? p : undefined }) })} /> : null}
    </Page>
  );
}

function Stat({ label, v, tone }: { label: string; v: number; tone: string }) {
  return (
    <div>
      <div className={cn("font-mono tabular text-[13px]", tone)}>{v}</div>
      <div className="eyebrow">{label}</div>
    </div>
  );
}
