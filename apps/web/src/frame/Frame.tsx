import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Briefcase,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  MessageSquareText,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radar,
  ScrollText,
  Search,
  Settings2,
  Sun,
  Target,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { api, client, post, type PositionRow, type TodayData } from "@/lib/api";
import { compact } from "@/lib/format";
import { Btn, IconBtn, Input, Kbd, Modal, cn } from "@/ui/kit";
import { CommandPalette } from "./CommandPalette";
import { Dock } from "./Dock";
import { setUi, toggleDock, useTheme, useUi } from "./store";

type AuthStatus = { authenticated: boolean; mode: string };

export function RootLayout() {
  const auth = useQuery<AuthStatus>({
    queryKey: ["auth"],
    queryFn: () => api<AuthStatus>("/api/v1/auth/status"),
    staleTime: 60_000,
    retry: false,
  });

  if (auth.isLoading) {
    return (
      <div className="h-full grid place-items-center">
        <div className="font-mono text-[12px] text-faint animate-pulse">connecting to job-scout…</div>
      </div>
    );
  }
  if (auth.isError || (auth.data && !auth.data.authenticated && !client.getToken())) {
    return <Login onDone={() => auth.refetch()} />;
  }
  return <Frame />;
}

/* ------------------------------------------------------------------ frame */

export function useToday() {
  return useQuery<TodayData>({
    queryKey: ["today"],
    queryFn: () => api<TodayData>("/api/v1/today"),
    refetchInterval: 30_000,
  });
}

function Frame() {
  const ui = useUi();
  const today = useToday();
  const navigate = useNavigate();

  // global keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement | null)?.isContentEditable;
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setUi({ paletteOpen: true });
      } else if (meta && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleDock("chat");
      } else if (meta && e.key.toLowerCase() === "i") {
        e.preventDefault();
        toggleDock("inbox");
      } else if (meta && e.key === ".") {
        e.preventDefault();
        toggleDock();
      } else if (!meta && !typing && e.key === "/") {
        e.preventDefault();
        setUi({ paletteOpen: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pending = today.data?.approvals.length ?? 0;
  const c = today.data?.counts.byStatus || {};
  const hot = ["review", "materials", "applied", "screen", "interview", "offer"].reduce((n, s) => n + (c[s] || 0), 0);
  const running = (today.data?.queue || []).filter((q) => q.status === "running").reduce((n, q) => n + q.c, 0);
  const queued = (today.data?.queue || []).filter((q) => q.status === "queued").reduce((n, q) => n + q.c, 0);

  return (
    <div className="h-full flex min-h-0 bg-bg">
      <Sidebar
        collapsed={ui.sidebarCollapsed}
        counts={{ today: today.data?.decisions.length ?? 0, pipeline: hot, inbox: pending }}
        footer={{ running, queued, llm24: (today.data?.llm.byOperation || []).reduce((n, r) => n + r.runs, 0) }}
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Topbar pending={pending} running={running} />
        <div className="flex-1 flex min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto pb-16 md:pb-0">
            <Outlet />
          </main>
          {ui.dockOpen ? <Dock /> : null}
        </div>
      </div>
      <MobileNav counts={{ today: today.data?.decisions.length ?? 0, inbox: pending }} />
      <CommandPalette open={ui.paletteOpen} onClose={() => setUi({ paletteOpen: false })} />
      <AddUrlModal
        open={ui.addOpen}
        onClose={() => setUi({ addOpen: false })}
        onCreated={(p) => {
          setUi({ addOpen: false });
          navigate({ to: "/positions/$id", params: { id: p.slug } });
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ sidebar */

const NAV = [
  { to: "/today", label: "Today", icon: Sun, key: "today" as const },
  { to: "/pipeline", label: "Pipeline", icon: Briefcase, key: "pipeline" as const },
  { to: "/discovery", label: "Discovery", icon: Radar, key: null },
  { to: "/sources", label: "Sources", icon: Activity, key: null },
  { to: "/companies", label: "Companies", icon: Building2, key: null },
  { to: "/inbox", label: "Inbox", icon: Inbox, key: "inbox" as const },
  { to: "/ai-logs", label: "AI logs", icon: ScrollText, key: null },
];

function Sidebar({ collapsed, counts, footer }: { collapsed: boolean; counts: { today: number; pipeline: number; inbox: number }; footer: { running: number; queued: number; llm24: number } }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <aside className={cn("hidden md:flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200", collapsed ? "w-[56px]" : "w-[208px]")}>
      <div className={cn("flex items-center h-12 border-b border-border", collapsed ? "justify-center" : "px-3 gap-2.5")}>
        <Brand />
        {!collapsed ? (
          <div className="min-w-0 leading-none">
            <div className="font-display font-semibold text-[14px] tracking-tight">job-scout</div>
            <div className="font-mono text-[10px] text-faint mt-0.5">v{__APP_VERSION__}</div>
          </div>
        ) : null}
      </div>
      <nav className="flex-1 p-2 space-y-0.5 overflow-y-auto">
        {NAV.map((n) => {
          const active = pathname === n.to || pathname.startsWith(n.to + "/") || (n.to === "/pipeline" && pathname.startsWith("/positions")) || (n.to === "/companies" && pathname.startsWith("/companies"));
          const badge = n.key ? counts[n.key] : 0;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              title={collapsed ? n.label : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md h-8 text-[13px] transition-colors",
                collapsed ? "justify-center px-0" : "px-2.5",
                active ? "bg-surface-3 text-fg" : "text-muted hover:text-fg hover:bg-surface-2",
              )}
            >
              {active ? <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-accent" /> : null}
              <Icon className={cn("h-4 w-4 shrink-0", active ? "text-accent" : "opacity-80")} />
              {!collapsed ? <span className="flex-1">{n.label}</span> : null}
              {badge > 0 ? (
                <span className={cn("font-mono text-[10px] tabular rounded px-1 leading-4", collapsed ? "absolute -top-0.5 right-1 bg-accent text-accent-ink" : "bg-accent/12 text-accent")}>{badge > 99 ? "99+" : badge}</span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="p-2 border-t border-border space-y-0.5">
        <Link to="/settings" title="Settings" className={cn("flex items-center gap-2.5 rounded-md h-8 text-[13px] text-muted hover:text-fg hover:bg-surface-2", collapsed ? "justify-center" : "px-2.5", pathname.startsWith("/settings") && "bg-surface-3 text-fg")}>
          <Settings2 className="h-4 w-4 shrink-0 opacity-80" />
          {!collapsed ? <span>Settings</span> : null}
        </Link>
        {!collapsed ? (
          <div className="px-2.5 pt-2 pb-1 font-mono text-[10.5px] text-faint tabular space-y-1">
            <div className="flex justify-between">
              <span>worker</span>
              <span className={footer.running ? "text-accent" : ""}>
                {footer.running ? `${footer.running} running` : "idle"}
                {footer.queued ? ` · ${footer.queued} q` : ""}
              </span>
            </div>
            <div className="flex justify-between">
              <span>llm 24h</span>
              <span>{compact(footer.llm24)} calls</span>
            </div>
          </div>
        ) : null}
        <button type="button" onClick={() => setUi({ sidebarCollapsed: !collapsed })} className={cn("flex items-center gap-2.5 rounded-md h-7 w-full text-[11px] text-faint hover:text-fg hover:bg-surface-2", collapsed ? "justify-center" : "px-2.5")} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" /> : <ChevronsLeft className="h-3.5 w-3.5" />}
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>
    </aside>
  );
}

function Brand({ className }: { className?: string }) {
  return (
    <div className={cn("h-7 w-7 rounded-md bg-accent/15 border border-accent/40 grid place-items-center shrink-0", className)}>
      <Target className="h-3.5 w-3.5 text-accent" />
    </div>
  );
}

function MobileNav({ counts }: { counts: { today: number; inbox: number } }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const items = [...NAV, { to: "/settings", label: "Settings", icon: Settings2, key: null }];
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-surface/95 backdrop-blur flex" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {items.map((n) => {
        const active = pathname === n.to || pathname.startsWith(n.to + "/");
        const badge = n.key === "today" ? counts.today : n.key === "inbox" ? counts.inbox : 0;
        const Icon = n.icon;
        return (
          <Link key={n.to} to={n.to} className={cn("flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] relative", active ? "text-accent" : "text-muted")}>
            <Icon className="h-4 w-4" />
            <span>{n.label}</span>
            {badge > 0 ? <span className="absolute top-1 right-[22%] font-mono text-[9px] tabular bg-accent text-accent-ink px-1 rounded leading-3">{badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------ topbar */

function Topbar({ pending, running }: { pending: number; running: number }) {
  const ui = useUi();
  const theme = useTheme();
  const crumbs = useCrumbs();
  return (
    <header className="h-12 shrink-0 border-b border-border bg-surface flex items-center gap-2 px-3">
      <div className="md:hidden flex items-center gap-2 mr-1">
        <Brand />
      </div>
      <nav className="flex items-center gap-1.5 min-w-0 text-[13px]" aria-label="breadcrumb">
        {crumbs.map((cr, i) => (
          <span key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 ? <span className="text-faint">/</span> : null}
            {cr.to ? (
              <Link to={cr.to} className="text-muted hover:text-fg truncate">
                {cr.label}
              </Link>
            ) : (
              <span className="text-fg truncate font-medium">{cr.label}</span>
            )}
          </span>
        ))}
      </nav>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => setUi({ paletteOpen: true })}
        className="hidden sm:flex items-center gap-2 h-8 w-[260px] rounded-md border border-border bg-bg px-2.5 text-[12px] text-faint hover:border-border-strong transition-colors"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 text-left">Search positions, companies, actions</span>
        <Kbd>⌘K</Kbd>
      </button>
      <IconBtn label="Search" className="sm:hidden" onClick={() => setUi({ paletteOpen: true })}>
        <Search className="h-4 w-4" />
      </IconBtn>
      <Btn variant="primary" onClick={() => setUi({ addOpen: true })} title="Add position from URL">
        <Plus className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Add URL</span>
      </Btn>
      <span className="w-px h-5 bg-border mx-1" />
      <DockButton tab="wire" label="Wire" icon={<Activity className="h-4 w-4" />} active={ui.dockOpen && ui.dockTab === "wire"} live={running > 0} />
      <DockButton tab="inbox" label="Inbox" icon={<Inbox className="h-4 w-4" />} active={ui.dockOpen && ui.dockTab === "inbox"} badge={pending} />
      <DockButton tab="chat" label="Chat" icon={<MessageSquareText className="h-4 w-4" />} active={ui.dockOpen && ui.dockTab === "chat"} />
      <IconBtn label={theme.resolved === "dark" ? "Switch to light" : "Switch to dark"} onClick={theme.toggle}>
        {theme.resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </IconBtn>
      <IconBtn label={ui.dockOpen ? "Hide side panel" : "Show side panel"} className="hidden lg:inline-flex" onClick={() => toggleDock()}>
        {ui.dockOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
      </IconBtn>
    </header>
  );
}

function DockButton({ tab, label, icon, active, badge, live }: { tab: "wire" | "inbox" | "chat"; label: string; icon: ReactNode; active: boolean; badge?: number; live?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => toggleDock(tab)}
      title={label}
      aria-pressed={active}
      className={cn("relative inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] transition-colors", active ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}
    >
      {icon}
      <span className="hidden xl:inline">{label}</span>
      {badge ? <span className="font-mono text-[10px] tabular rounded bg-accent text-accent-ink px-1 leading-4">{badge}</span> : null}
      {live ? <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent animate-pulse" /> : null}
    </button>
  );
}

function useCrumbs(): { label: string; to?: string }[] {
  const { pathname } = useRouterState({ select: (s) => s.location });
  const ui = useUi();
  const seg = pathname.split("/").filter(Boolean);
  const first = seg[0] || "today";
  const names: Record<string, string> = { today: "Today", pipeline: "Pipeline", radar: "Radar", companies: "Companies", inbox: "Inbox", "ai-logs": "AI logs", settings: "Settings", positions: "Pipeline" };
  const root = { label: names[first] || first, to: first === "positions" ? "/pipeline" : `/${first}` };
  if (seg.length === 1) return [{ label: root.label }];
  if (first === "positions" && ui.chatScope.scope === "position") return [root, { label: ui.chatScope.label }];
  if (first === "companies" && ui.chatScope.scope === "company") return [root, { label: ui.chatScope.label }];
  return [root, { label: decodeURIComponent(seg[1] || "") }];
}

/* ------------------------------------------------------------------ add url */

function AddUrlModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: PositionRow) => void }) {
  const [url, setUrl] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      const p = await post<PositionRow>("/api/v1/positions", { url: url.trim(), companyName: company.trim() || undefined });
      toast.success(`${p.company?.name || "Position"} added — triage queued`);
      qc.invalidateQueries({ queryKey: ["positions"] });
      qc.invalidateQueries({ queryKey: ["today"] });
      setUrl("");
      setCompany("");
      onCreated(p);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add position");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add position">
      <form onSubmit={submit} className="p-4 space-y-3">
        <p className="text-[12.5px] text-muted">Paste any job URL. Greenhouse, Ashby and Lever are read directly; Workday and SPA pages go through the browser. The JD is fetched, gated and triaged in the background.</p>
        <Input label="Job URL" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://boards.greenhouse.io/…" />
        <Input label="Company (optional)" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Only if the page does not say" />
        <div className="flex justify-end gap-2 pt-1">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" type="submit" disabled={busy || !url.trim()}>
            {busy ? "Adding…" : "Add and triage"}
          </Btn>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ login */

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw }) });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } | string };
      if (!json.ok) throw new Error(typeof json.error === "string" ? json.error : json.error?.message || "Sign-in failed");
      if (pw.startsWith("js_")) client.setToken(pw);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full grid place-items-center p-6 grid-paper">
      <form onSubmit={submit} className="w-full max-w-[340px] rounded-xl border border-border bg-surface p-6 space-y-4 shadow-pop">
        <div className="flex items-center gap-3">
          <Brand className="h-9 w-9" />
          <div>
            <div className="font-display font-semibold text-[16px] leading-none">job-scout</div>
            <div className="font-mono text-[10.5px] text-faint mt-1">career control plane · v{__APP_VERSION__}</div>
          </div>
        </div>
        <Input label="Password or API token" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err ? <div className="text-xs text-bad">{err}</div> : null}
        <Btn variant="primary" size="md" type="submit" className="w-full" disabled={busy || !pw}>
          {busy ? "Signing in…" : "Sign in"}
        </Btn>
      </form>
    </div>
  );
}
