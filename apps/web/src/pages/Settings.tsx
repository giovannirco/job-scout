import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Bot, Copy, Globe, Hand, MessageCircle, Play, RefreshCw, Sparkles, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { clipBookmarklet, pausedGeoBlocks, titleExcludesFromNorthStar } from "@job-scout/shared";
import { useChatScope, useTheme, type ThemePref } from "@/frame/store";
import { api, del, patch, post, qs, useApi, type ApiToken, type AutopilotConfig, type AutopilotState, type Job, type LlmStatus, type ModelsCatalog, type NotificationsConfig, type NotifyChannel, type Profile, type Settings, type SystemInfo } from "@/lib/api";
import { ago, compact, dateTime } from "@/lib/format";
import { discoveryQueuedMessage } from "@/lib/discovery-toast";
import type { SettingsSearch } from "@/router";
import { Btn, Budget, Card, Chip, Dot, Empty, IconBtn, Input, Loading, Page, Panel, Seg, Select, Switch, Table, Td, Textarea, Th, Tr, cn } from "@/ui/kit";

type Tab = NonNullable<SettingsSearch["tab"]>;

const TABS: { value: Tab; label: string; blurb: string }[] = [
  { value: "profile", label: "Profile", blurb: "What the models know about you" },
  { value: "gate", label: "Gate", blurb: "Deterministic filter before any model call" },
  { value: "ai", label: "AI models", blurb: "Model per operation, caps, gateway" },
  { value: "autopilot", label: "Autopilot", blurb: "How much runs unattended" },
  { value: "notifications", label: "Notifications", blurb: "WhatsApp groups via a WAHA server" },
  { value: "appearance", label: "Appearance", blurb: "Theme" },
  { value: "system", label: "System", blurb: "Jobs, retention, tokens, job-scout Steel" },
];

export function SettingsPage() {
  useChatScope({ scope: "global" });
  const search = useSearch({ from: "/settings" });
  const navigate = useNavigate({ from: "/settings" });
  const tab: Tab = search.tab || "profile";
  const current = TABS.find((t) => t.value === tab)!;
  return (
    <Page wide className="md:grid md:grid-cols-[200px_1fr] md:gap-8 md:space-y-0 items-start">
      <nav className="md:sticky md:top-6 space-y-0.5 mb-4 md:mb-0 flex md:block gap-1 overflow-x-auto no-scrollbar">
        <div className="eyebrow px-2.5 pb-2 hidden md:block">Settings</div>
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => navigate({ search: { tab: t.value === "profile" ? undefined : t.value } })}
            className={cn("block w-full text-left rounded-md px-2.5 py-1.5 text-[13px] whitespace-nowrap transition-colors", tab === t.value ? "bg-surface-3 text-fg" : "text-muted hover:text-fg hover:bg-surface-2")}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 space-y-5">
        <div>
          <h1 className="font-display text-[22px] font-semibold tracking-[-0.01em] leading-tight">{current.label}</h1>
          <div className="text-[12.5px] text-muted mt-0.5">{current.blurb}</div>
        </div>
        {tab === "profile" ? <ProfileTab /> : null}
        {tab === "gate" ? <GateTab /> : null}
        {tab === "ai" ? <AiTab /> : null}
        {tab === "autopilot" ? <AutopilotTab /> : null}
        {tab === "notifications" ? <NotificationsTab /> : null}
        {tab === "appearance" ? <AppearanceTab /> : null}
        {tab === "system" ? <SystemTab /> : null}
      </div>
    </Page>
  );
}

const EVENT_LABELS: { key: keyof NotificationsConfig["events"]; label: string; room: string }[] = [
  { key: "triage_pass", label: "Triage PASS", room: "new" },
  { key: "approval_pending", label: "Inbox approvals", room: "desk" },
  { key: "interview_scheduled", label: "Interview scheduled", room: "desk" },
  { key: "stale_applied", label: "Stale applied (7d)", room: "desk" },
  { key: "status_hot", label: "Applied / screen / interview / offer", room: "process" },
  { key: "jd_change_hot", label: "JD change on hot roles", room: "process" },
  { key: "listing_closed_hot", label: "Listing closed on hot roles", room: "process" },
  { key: "company_research", label: "Company research pack", room: "research" },
];
const CHANNELS: NotifyChannel[] = ["desk", "new", "process", "research", "chat"];

function NotificationsTab() {
  const q = useApi<NotificationsConfig & { wahaConfigured: boolean }>(["notifications"], "/api/v1/settings/notifications");
  const qc = useQueryClient();
  const [f, setF] = useState<NotificationsConfig | null>(null);
  useEffect(() => {
    if (q.data) {
      const { wahaConfigured: _w, ...rest } = q.data;
      void _w;
      setF(rest);
    }
  }, [q.data]);
  if (!f || !q.data) return <Loading rows={6} />;
  const { wahaConfigured: _w, ...base } = q.data;
  void _w;
  const dirty = JSON.stringify(f) !== JSON.stringify(base);
  async function save() {
    if (!f) return;
    await patch("/api/v1/settings", { notifications: f });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    toast.success("Notifications saved");
  }
  async function test(channel: NotifyChannel) {
    const r = await post<{ ok: boolean; error?: string; chatId: string }>("/api/v1/settings/notifications/test", { channel });
    if (r.ok) toast.success(`Test sent to ${channel}`);
    else toast.error(r.error || "Test failed");
  }
  return (
    <div className="space-y-5 max-w-3xl">
      <Panel title="WhatsApp" meta={q.data.wahaConfigured ? "WAHA connected" : "WAHA env missing — sends no-op until WAHA_API_KEY is set"}>
        <div className="p-3 space-y-3">
          <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Send product alerts" />
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <MessageCircle className="h-3.5 w-3.5" />
            Desk chat model <span className="text-fg">{f.chat.model}</span>
            {f.channels.chat.chatId.trim() ? " · replies go to the chat group" : " · add a chat group id to receive replies"}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Min triage score for new" type="number" step="0.1" value={f.minTriageScore} onChange={(e) => setF({ ...f, minTriageScore: Number(e.target.value) })} />
            <Input label="Session" value={f.session} onChange={(e) => setF({ ...f, session: e.target.value })} />
          </div>
        </div>
      </Panel>
      <Panel title="Groups" meta="chatIds on a WAHA server">
        <div className="divide-y divide-border">
          {CHANNELS.map((ch) => (
            <div key={ch} className="p-3 flex flex-wrap items-center gap-2">
              <Switch checked={f.channels[ch].enabled} onChange={(v) => setF({ ...f, channels: { ...f.channels, [ch]: { ...f.channels[ch], enabled: v } } })} label={ch} />
              <Input className="flex-1 min-w-[12rem]" placeholder="WhatsApp chat id" value={f.channels[ch].chatId} onChange={(e) => setF({ ...f, channels: { ...f.channels, [ch]: { ...f.channels[ch], chatId: e.target.value } } })} />
              <Btn
                disabled={!q.data.wahaConfigured || !f.channels[ch].chatId.trim()}
                title={q.data.wahaConfigured ? (f.channels[ch].chatId.trim() ? "Send a test message" : "Add a chat id first") : "Set WAHA_API_KEY before sending a test"}
                onClick={() => void test(ch)}
              >
                Test
              </Btn>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Events">
        <div className="p-3 space-y-2">
          {EVENT_LABELS.map((e) => (
            <Switch
              key={e.key}
              checked={f.events[e.key]}
              onChange={(v) => setF({ ...f, events: { ...f.events, [e.key]: v } })}
              label={`${e.label} → ${e.room}`}
            />
          ))}
        </div>
      </Panel>
      <Panel title="Quiet hours" meta="alerts delay; chat still replies">
        <div className="p-3 space-y-2">
          <Switch checked={f.quietHours.enabled} onChange={(v) => setF({ ...f, quietHours: { ...f.quietHours, enabled: v } })} label="Hold alerts overnight" />
          <div className="grid grid-cols-3 gap-2">
            <Input label="Timezone" value={f.quietHours.timezone} onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours, timezone: e.target.value } })} />
            <Input label="Start" hint="24-hour, local to the timezone" value={f.quietHours.start} onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours, start: e.target.value } })} />
            <Input label="End" value={f.quietHours.end} onChange={(e) => setF({ ...f, quietHours: { ...f.quietHours, end: e.target.value } })} />
          </div>
        </div>
      </Panel>
      <SaveBar dirty={dirty} onSave={() => void save()} />
    </div>
  );
}

function SaveBar({ dirty, onSave, label = "Save changes" }: { dirty: boolean; onSave: () => void; label?: string }) {
  return (
    <div className="flex justify-end sticky bottom-3">
      <Btn variant="primary" size="md" onClick={onSave} disabled={!dirty} className={cn(dirty && "shadow-pop")}>
        {label}
      </Btn>
    </div>
  );
}

/* ---------------- Profile ---------------- */

function ProfileTab() {
  const q = useApi<Profile>(["profile"], "/api/v1/settings/profile");
  const qc = useQueryClient();
  const [f, setF] = useState<Partial<Profile>>({});
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const dirty = useMemo(() => JSON.stringify(f) !== JSON.stringify(q.data || {}), [f, q.data]);

  async function save() {
    const rolesChanged = JSON.stringify(f.targetRoles || []) !== JSON.stringify(q.data?.targetRoles || []);
    const locationChanged = (f.location || "") !== (q.data?.location || "");
    const { id: _id, ...rest } = f as Profile;
    void _id;
    await patch("/api/v1/settings/profile", rest);
    void qc.invalidateQueries({ queryKey: ["profile"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ queryKey: ["radar"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    toast.success(
      rolesChanged
        ? "Profile saved. Target roles now filter listings, and untouched filings that miss the title are archived."
        : locationChanged
          ? "Profile saved. Remote roles that require another country were archived."
          : "Profile saved",
    );
  }
  if (q.isLoading || !q.data) return <Loading rows={6} />;
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const northStarExcludes = titleExcludesFromNorthStar(f.northStar || "");

  return (
    <div className="space-y-4 max-w-4xl">
      <p className="text-[12.5px] text-muted">
        The <b className="text-fg font-medium">scout brief</b> is what triage reads. <b className="text-fg font-medium">Target roles</b> are the title gate: saving them rechecks listings from the last 7 days. Untouched scan filings whose titles no longer match are archived. A specialty word such as java is kept on its own, so Java Developer still matches, and it does not match JavaScript. Engineer and developer are the same shape, so Software Engineer also matches Software Developer. Extra include or exclude terms stay under Gate.
      </p>
      <Panel title="Identity">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Input label="Display name" value={f.displayName || ""} onChange={(e) => set("displayName", e.target.value)} />
          <Input label="Email" value={f.email || ""} onChange={(e) => set("email", e.target.value)} />
          <Input label="Location" hint="A US city drops roles that require another country, and keeps “Remote - US only”. A Brazil city drops US-only roles. Other cities do not filter. Clearing this does not restore archived filings." value={f.location || ""} onChange={(e) => set("location", e.target.value)} />
          <Input label="Last title" value={f.lastTitle || ""} onChange={(e) => set("lastTitle", e.target.value)} />
          <Input label="Last company" value={f.lastCompany || ""} onChange={(e) => set("lastCompany", e.target.value)} />
          <Input label="Cash floor (USD / yr)" type="number" value={f.cashFloorUsd ?? 0} onChange={(e) => set("cashFloorUsd", Number(e.target.value))} />
          <Input label="LinkedIn" value={f.linkedinUrl || ""} onChange={(e) => set("linkedinUrl", e.target.value)} />
          <Input label="GitHub" value={f.githubUrl || ""} onChange={(e) => set("githubUrl", e.target.value)} />
          <Input label="Target roles (comma)" value={(f.targetRoles || []).join(", ")} onChange={(e) => set("targetRoles", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </div>
      </Panel>
      <Panel title="What the models read">
        <div className="space-y-3">
          <Textarea label="North star — one paragraph on what you want next" hint="The model reads this after a key is set. Some sentences also exclude titles before any model runs. Saving the profile applies that list." value={f.northStar || ""} onChange={(e) => set("northStar", e.target.value)} className="min-h-[60px]" />
          {northStarExcludes.length ? (
            <p className="text-[12px] text-muted">Also excluded from this paragraph: {northStarExcludes.join(", ")}.</p>
          ) : null}
          <Textarea label="Scout brief (triage prompt: archetypes, hard DQs, comp floor, location rules)" value={f.scoutBrief || ""} onChange={(e) => set("scoutBrief", e.target.value)} className="min-h-[220px] font-mono text-[12px]" />
          <Textarea label="Identity (who you are, proof points; used by evaluate)" value={f.identityMarkdown || ""} onChange={(e) => set("identityMarkdown", e.target.value)} className="min-h-[160px] font-mono text-[12px]" />
          <Textarea label="Master resume (markdown)" value={f.masterResumeMarkdown || ""} onChange={(e) => set("masterResumeMarkdown", e.target.value)} className="min-h-[320px] font-mono text-[12px]" />
          <Textarea label="Master cover letter template (markdown)" value={f.masterCoverMarkdown || ""} onChange={(e) => set("masterCoverMarkdown", e.target.value)} className="min-h-[160px] font-mono text-[12px]" />
          <Textarea
            label="Resume surfaces (JSON: name → what to emphasize)"
            value={JSON.stringify(f.resumeSurfaces || {}, null, 2)}
            onChange={(e) => {
              try {
                set("resumeSurfaces", JSON.parse(e.target.value));
              } catch {
                /* keep typing */
              }
            }}
            className="min-h-[80px] font-mono text-[12px]"
          />
        </div>
      </Panel>
      <SaveBar dirty={dirty} onSave={save} label="Save profile" />
    </div>
  );
}

/* ---------------- Gate ---------------- */

function ListEditor({ label, value, onChange, hint }: { label: string; value: string[]; onChange: (v: string[]) => void; hint?: string }) {
  const [text, setText] = useState(value.join("\n"));
  useEffect(() => setText(value.join("\n")), [value]);
  return <Textarea label={label} hint={hint} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split("\n").map((s) => s.trim()).filter(Boolean))} className="min-h-[180px] font-mono text-[12px]" />;
}

function GateTab() {
  const q = useApi<Settings>(["settings"], "/api/v1/settings");
  const qc = useQueryClient();
  const [gate, setGate] = useState<Settings["gate"] | null>(null);
  const [triage, setTriage] = useState<Settings["triage"] | null>(null);
  const [scan, setScan] = useState<Settings["scan"] | null>(null);
  useEffect(() => {
    if (q.data) {
      setGate(q.data.gate);
      setTriage(q.data.triage);
      setScan(q.data.scan);
    }
  }, [q.data]);
  const profile = useApi<Profile>(["profile"], "/api/v1/settings/profile");
  const northStarExcludes = titleExcludesFromNorthStar(profile.data?.northStar || "");
  if (!gate || !triage || !scan) return <Loading rows={6} />;
  const pausedBlocks = pausedGeoBlocks(profile.data?.location, gate.geoBlock);
  const dirty = JSON.stringify({ gate, triage, scan }) !== JSON.stringify({ gate: q.data?.gate, triage: q.data?.triage, scan: q.data?.scan });

  async function save() {
    await patch("/api/v1/settings", { gate, triage, scan });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ queryKey: ["radar"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    toast.success(JSON.stringify(gate) !== JSON.stringify(q.data?.gate) ? "Gate saved. Recent listings were checked again." : "Gate saved");
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <p className="text-[12.5px] text-muted">
        A listing must match one <b className="text-fg font-medium">title include</b> term and no <b className="text-fg font-medium">exclude</b> term or geo block. A single word matches a whole word, so <span className="font-mono">java</span> does not match JavaScript. Saving rechecks listings seen in the last 7 days.
      </p>
      <div className="grid md:grid-cols-2 gap-3">
        <Panel title="Title include">
          <ListEditor label="One per line" value={gate.titleInclude} onChange={(v) => setGate({ ...gate, titleInclude: v })} />
        </Panel>
        <Panel title="Title exclude">
          <ListEditor label="One per line" value={gate.titleExclude} onChange={(v) => setGate({ ...gate, titleExclude: v })} />
          {northStarExcludes.length ? <p className="text-[12px] text-muted mt-2">The north star also excludes: {northStarExcludes.join(", ")}. Edit that on Profile.</p> : null}
        </Panel>
        <Panel title="Geo allow">
          <ListEditor label="One per line" value={gate.geoAllow} onChange={(v) => setGate({ ...gate, geoAllow: v })} hint="Location strings containing any of these pass." />
        </Panel>
        <Panel title="Geo block">
          <ListEditor label="One per line" value={gate.geoBlock} onChange={(v) => setGate({ ...gate, geoBlock: v })} hint="Checked after allow. A block wins when the location also matches an allow term." />
          {pausedBlocks.length ? <p className="text-[12px] text-muted mt-2">Saved, but not applied while the profile is in the US: {pausedBlocks.join(", ")}. A US city still keeps “Remote - US only”.</p> : null}
        </Panel>
      </div>
      <Panel title="Thresholds and cadence">
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Input label="Max posting age (days, 0 = ignore)" type="number" value={gate.maxPostingAgeDays} onChange={(e) => setGate({ ...gate, maxPostingAgeDays: Number(e.target.value) })} />
          <Select label="Unknown geo" value={gate.allowUnknownGeo ? "pass" : "filter"} onChange={(e) => setGate({ ...gate, allowUnknownGeo: e.target.value === "pass" })}>
            <option value="pass">keep the listing</option>
            <option value="filter">filter out</option>
          </Select>
          <Input label="Triage PASS ≥" type="number" step="0.1" value={triage.passThreshold} onChange={(e) => setTriage({ ...triage, passThreshold: Number(e.target.value) })} />
          <Input label="Triage MARGINAL ≥" type="number" step="0.1" value={triage.marginalThreshold} onChange={(e) => setTriage({ ...triage, marginalThreshold: Number(e.target.value) })} />
          <Input label="JD chars sent to triage" type="number" value={triage.jdMaxChars} onChange={(e) => setTriage({ ...triage, jdMaxChars: Number(e.target.value) })} />
          <Select label="Marginal verdicts" value={triage.keepMarginal ? "keep" : "archive"} onChange={(e) => setTriage({ ...triage, keepMarginal: e.target.value === "keep" })}>
            <option value="keep">keep in pipeline</option>
            <option value="archive">archive</option>
          </Select>
          <Input label="Board scan interval (min)" type="number" value={scan.boardIntervalMinutes} onChange={(e) => setScan({ ...scan, boardIntervalMinutes: Number(e.target.value) })} />
          <Input label="Boards per tick" type="number" value={scan.boardsPerTick} onChange={(e) => setScan({ ...scan, boardsPerTick: Number(e.target.value) })} />
        </div>
      </Panel>
      <p className="text-[11.5px] text-faint">
        Board sources and URL watches are managed in{" "}
        <Link to="/radar" search={{ tab: "boards" }} className="text-accent hover:underline">
          Radar › Sources
        </Link>
        . Whether new positions get triaged automatically is an Autopilot setting.
      </p>
      <SaveBar dirty={dirty} onSave={save} label="Save gate" />
    </div>
  );
}

/* ---------------- AI ---------------- */

const OP_HELP: Record<string, string> = {
  triage: "Every gated listing. Cheap and fast; hundreds of calls a day.",
  evaluate: "Full A–H report. Strong model.",
  materials: "Resume + cover for one position. Strong model, careful writer.",
  company_research: "Company dossier. Mid model with good recall.",
  jd_review: "Line-by-line JD read after a material change. Mid model.",
  chat: "The chat panel. Needs solid tool calling.",
  test: "Smoke calls from this page.",
  listing_classify: "Cheap pass when ATS workplace/geo is messy. Tightens to hard_geo only.",
  form_answers: "Draft application-form answers from profile + resume. Status stays open.",
  interview_brief: "Debrief one round vs the JD and company pack. Same class as evaluate if unset.",
};

function AiTab() {
  const status = useApi<LlmStatus>(["llm", "status"], "/api/v1/settings/llm/status", { refetchInterval: 30_000 });
  const catalog = useApi<ModelsCatalog>(["llm", "models"], "/api/v1/settings/llm/models");
  const runsQuery = useApi<{ items: { id: string; operation: string; model: string; status: string; tokensIn: number | null; tokensOut: number | null; latencyMs: number | null; error: string | null; createdAt: string; positionId: string | null }[]; total: number }>(
    ["llm", "runs"],
    "/api/v1/settings/llm/runs?limit=40",
    { refetchInterval: 30_000 },
  );
  const runs = { ...runsQuery, data: runsQuery.data?.items };
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, { model: string; enabled: boolean; dailyCap: number }>>({});
  const [fallback, setFallback] = useState("");
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    if (status.data) {
      const d: typeof draft = {};
      for (const op of status.data.operations) d[op.id] = { model: op.model, enabled: op.enabled, dailyCap: op.dailyCap };
      setDraft(d);
      setFallback(status.data.fallbackModel ?? "");
    }
  }, [status.data]);

  const dirty = status.data
    ? fallback !== (status.data.fallbackModel ?? "") ||
      status.data.operations.some((op) => JSON.stringify(draft[op.id]) !== JSON.stringify({ model: op.model, enabled: op.enabled, dailyCap: op.dailyCap }))
    : false;

  async function save() {
    await patch("/api/v1/settings", { llm: { operations: draft, fallbackModel: fallback } });
    void qc.invalidateQueries({ queryKey: ["llm"] });
    toast.success("Models saved");
  }
  async function test(op: string) {
    const model = draft[op]?.model;
    if (!model) return toast.error("Pick a model first");
    setTesting(op);
    try {
      const r = await post<{ model: string; content: string; latencyMs: number }>("/api/v1/settings/llm/test", { model });
      toast.success(`${r.model}: “${r.content.trim().slice(0, 40)}” in ${r.latencyMs}ms`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setTesting(null);
      void qc.invalidateQueries({ queryKey: ["llm"] });
    }
  }
  async function refreshCatalog() {
    await qc.fetchQuery({ queryKey: ["llm", "models"], queryFn: () => api<ModelsCatalog>("/api/v1/settings/llm/models?refresh=1") });
    toast.success("Catalog refreshed");
  }

  if (status.isLoading || !status.data) return <Loading rows={6} />;
  const s = status.data;
  const groups = catalog.data?.groups || {};

  return (
    <div className="space-y-4">
      <Card className="p-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px]">
        <span className="inline-flex items-center gap-2">
          <Dot tone={s.configured ? "good" : "bad"} />
          <span className="text-faint">gateway</span>
          <span className="font-mono">{s.baseUrl}</span>
        </span>
        <span className={s.configured ? "text-good" : "text-bad"}>{s.configured ? "key configured" : "OPENAI_API_KEY missing"}</span>
        <span>
          <span className="text-faint">catalog </span>
          <span className="font-mono">{catalog.data?.models.length ?? "…"} models</span>
          {catalog.data?.cachedAt ? <span className="text-faint"> · cached {ago(catalog.data.cachedAt)} ago</span> : null}
          {catalog.data?.error ? <span className="text-bad"> · {catalog.data.error}</span> : null}
        </span>
        <Btn
          variant="ghost"
          size="xs"
          onClick={async () => {
            try {
              const r = await post<{ items: unknown[] }>("/api/v1/settings/llm/retry", { hours: 24, scope: "failed_and_missing" });
              toast.success(`Retry queued: ${r.items.length} jobs`);
              void qc.invalidateQueries({ queryKey: ["today"] });
              void qc.invalidateQueries({ queryKey: ["llm"] });
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Retry failed");
            }
          }}
          className="ml-auto"
        >
          <RefreshCw className="h-3 w-3" /> Retry failed
        </Btn>
        <Btn variant="ghost" size="xs" onClick={refreshCatalog}>
          <RefreshCw className="h-3 w-3" /> Refresh catalog
        </Btn>
      </Card>

      <Card className="p-3 flex flex-wrap items-center gap-3 text-[12px]">
        <div className="min-w-0">
          <div className="font-medium">Quota fallback</div>
          <div className="text-[11px] text-faint">When a selected model hits a provider quota or rate limit (Codex plan, 429), retry once on this model.</div>
        </div>
        <select
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
          className="h-7 rounded-md border border-border bg-bg px-2 text-[12px] font-mono min-w-[240px] outline-none focus:border-accent ml-auto"
        >
          <option value="">— off —</option>
          {fallback && !catalog.data?.models.some((m) => m.id === fallback) ? <option value={fallback}>{fallback} (not in catalog)</option> : null}
          {Object.entries(groups)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([owner, ids]) => (
              <optgroup key={owner} label={owner}>
                {ids.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </Card>

      <Table>
        <thead>
          <tr>
            <Th>Operation</Th>
            <Th>Model</Th>
            <Th>On</Th>
            <Th right>Daily cap</Th>
            <Th right>Today</Th>
            <Th right>24h</Th>
            <Th right>Fail</Th>
            <Th right>Tokens</Th>
            <Th right>Avg</Th>
            <Th w={70} />
          </tr>
        </thead>
        <tbody>
          {s.operations.map((op) => {
            const d = draft[op.id] || { model: op.model, enabled: op.enabled, dailyCap: op.dailyCap };
            const u = op.last24h;
            const capHit = op.dailyCap > 0 && op.today >= op.dailyCap;
            return (
              <Tr key={op.id} className={cn(!d.enabled && "opacity-60")}>
                <Td className="min-w-[220px]">
                  <div className="font-medium">{op.id.replace("_", " ")}</div>
                  <div className="text-[11px] text-faint">{OP_HELP[op.id]}</div>
                </Td>
                <Td>
                  <select value={d.model} onChange={(e) => setDraft({ ...draft, [op.id]: { ...d, model: e.target.value } })} className="h-7 rounded-md border border-border bg-bg px-2 text-[12px] font-mono min-w-[240px] outline-none focus:border-accent">
                    <option value="">— not set —</option>
                    {d.model && !catalog.data?.models.some((m) => m.id === d.model) ? <option value={d.model}>{d.model} (not in catalog)</option> : null}
                    {Object.entries(groups)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([owner, ids]) => (
                        <optgroup key={owner} label={owner}>
                          {ids.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                  </select>
                </Td>
                <Td>
                  <Switch checked={d.enabled} onChange={(v) => setDraft({ ...draft, [op.id]: { ...d, enabled: v } })} />
                </Td>
                <Td right>
                  <input type="number" min={0} value={d.dailyCap} onChange={(e) => setDraft({ ...draft, [op.id]: { ...d, dailyCap: Number(e.target.value) } })} className="w-[70px] h-7 rounded-md border border-border bg-bg px-2 text-[12px] font-mono text-right outline-none focus:border-accent" />
                </Td>
                <Td right mono className={capHit ? "text-bad" : ""}>
                  {op.today}
                  {op.dailyCap ? <span className="text-faint">/{op.dailyCap}</span> : null}
                </Td>
                <Td right mono>
                  {u?.runs ?? 0}
                </Td>
                <Td right mono className={u?.failures ? "text-bad" : "text-faint"}>
                  {u?.failures ?? 0}
                </Td>
                <Td right mono className="text-muted">
                  {u ? compact(u.tokensIn + u.tokensOut) : "0"}
                </Td>
                <Td right mono className="text-muted">
                  {u?.avgLatencyMs ? `${(u.avgLatencyMs / 1000).toFixed(1)}s` : "—"}
                </Td>
                <Td right>
                  <Btn size="xs" variant="ghost" onClick={() => test(op.id)} disabled={testing === op.id || !d.model} title="Smoke call with this model">
                    <Play className="h-3 w-3" /> {testing === op.id ? "…" : "Test"}
                  </Btn>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <SaveBar dirty={dirty} onSave={save} label="Save models" />

      <Panel
        title="Recent calls"
        meta={`${runs.data?.length ?? 0} of ${runsQuery.data?.total ?? 0}`}
        actions={
          <Link to="/ai-logs">
            <Btn variant="outline">Open AI logs</Btn>
          </Link>
        }
        flush
      >
        {runs.data?.length ? (
          <Table className="border-0 rounded-none" dense>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Op</Th>
                <Th>Model</Th>
                <Th>Status</Th>
                <Th right>Tokens</Th>
                <Th right>Latency</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <Tr key={r.id}>
                  <Td mono className="text-muted">
                    {dateTime(r.createdAt)}
                  </Td>
                  <Td mono>{r.operation}</Td>
                  <Td mono className="text-muted">
                    {r.model}
                  </Td>
                  <Td mono className={r.status === "ok" ? "text-good" : "text-bad"}>
                    {r.status}
                  </Td>
                  <Td right mono className="text-muted">
                    {r.tokensIn ?? "?"}→{r.tokensOut ?? "?"}
                  </Td>
                  <Td right mono className="text-muted">
                    {r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)}s` : "—"}
                  </Td>
                  <Td className="max-w-[300px] text-bad text-[11px]">
                    <div className="truncate" title={r.error || ""}>
                      {r.error || ""}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-3">
            <Empty>No calls logged yet.</Empty>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------- Autopilot ---------------- */

const PRESET_CARDS: { id: "manual" | "assisted" | "autopilot"; label: string; icon: typeof Hand; blurb: string; does: string[] }[] = [
  { id: "manual", label: "Manual", icon: Hand, blurb: "Nothing runs a model unless you click it.", does: ["Scans boards and gates listings", "Triage only when you ask", "No suggestions filed"] },
  { id: "assisted", label: "Assisted", icon: Sparkles, blurb: "Cheap steps run alone; anything that changes the pipeline waits in the inbox.", does: ["Triage every gated listing", "Evaluate strong PASS verdicts", "Research the company when evaluating", "File status suggestions for you to approve"] },
  { id: "autopilot", label: "Autopilot", icon: Bot, blurb: "Full loop: triage, evaluate, research, re-review changed JDs, draft materials — all landing in the inbox.", does: ["Everything in Assisted", "Evaluate all PASS verdicts", "Re-review JDs that change", "Draft resume + cover above the bar"] },
];

function AutopilotTab() {
  const q = useApi<AutopilotState>(["autopilot"], "/api/v1/settings/autopilot", { refetchInterval: 30_000 });
  const qc = useQueryClient();
  const [cfg, setCfg] = useState<AutopilotConfig | null>(null);
  useEffect(() => {
    if (q.data) {
      const { presets: _p, summary: _s, budgetToday: _b, ...c } = q.data;
      void _p;
      void _s;
      void _b;
      setCfg(c);
    }
  }, [q.data]);
  if (!cfg || !q.data) return <Loading rows={6} />;
  const base = (() => {
    const { presets: _p, summary: _s, budgetToday: _b, ...c } = q.data;
    void _p;
    void _s;
    void _b;
    return c;
  })();
  const dirty = JSON.stringify(cfg) !== JSON.stringify(base);

  async function applyPreset(p: "manual" | "assisted" | "autopilot") {
    await post("/api/v1/settings/autopilot/preset", { preset: p });
    void qc.invalidateQueries({ queryKey: ["autopilot"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    toast.success(`Autopilot set to ${p}`);
  }
  async function save() {
    if (!cfg) return;
    await patch("/api/v1/settings", { autopilot: { ...cfg, preset: "custom" } });
    void qc.invalidateQueries({ queryKey: ["autopilot"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    toast.success("Autopilot saved");
  }
  const set = (patchCfg: Partial<AutopilotConfig>) => setCfg((c) => (c ? { ...c, ...patchCfg } : c));
  const summary = q.data.summary;
  const auto24 = summary.autoJobs24h.reduce((n, j) => n + j.c, 0);

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="grid md:grid-cols-3 gap-3">
        {PRESET_CARDS.map((p) => {
          const active = cfg.preset === p.id;
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className={cn("text-left rounded-lg border p-4 transition-colors relative", active ? "border-accent bg-accent/[0.06]" : "border-border bg-surface hover:border-border-strong")}
            >
              {active ? <span className="absolute top-3 right-3 h-2 w-2 rounded-full bg-accent" /> : null}
              <Icon className={cn("h-5 w-5 mb-3", active ? "text-accent" : "text-muted")} />
              <div className="font-display font-semibold text-[15px]">{p.label}</div>
              <div className="text-[12px] text-muted mt-1 leading-snug">{p.blurb}</div>
              <ul className="mt-3 space-y-1">
                {p.does.map((d) => (
                  <li key={d} className="text-[11.5px] text-muted flex gap-1.5">
                    <span className="text-faint">·</span>
                    {d}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
      {cfg.preset === "custom" ? (
        <div className="text-[12px] text-muted flex items-center gap-2">
          <Chip tone="accent">custom</Chip> Rules below differ from every preset.
        </div>
      ) : null}

      <div className="grid lg:grid-cols-[1fr_300px] gap-5 items-start">
        <Panel title="Rules" meta="what runs after each step">
          <div className="space-y-4">
            <Rule title="New listing passes the gate" what="Triage with the cheap model. Sets score and verdict.">
              <Switch checked={cfg.triageNew} onChange={(v) => set({ triageNew: v })} label="Triage automatically" />
            </Rule>
            <Rule title="Triage returns PASS" what="Full A–H evaluation with the strong model.">
              <div className="flex flex-wrap items-center gap-3">
                <Seg<AutopilotConfig["evaluate"]["mode"]>
                  value={cfg.evaluate.mode}
                  onChange={(mode) => set({ evaluate: { ...cfg.evaluate, mode } })}
                  options={[
                    { value: "off", label: "Never" },
                    { value: "threshold", label: "Score ≥" },
                    { value: "all_pass", label: "Every PASS" },
                  ]}
                />
                {cfg.evaluate.mode === "threshold" ? <input type="number" step="0.1" min={0} max={5} value={cfg.evaluate.minTriageScore} onChange={(e) => set({ evaluate: { ...cfg.evaluate, minTriageScore: Number(e.target.value) } })} className="w-[64px] h-7 rounded-md border border-border bg-bg px-2 text-[12px] font-mono text-right outline-none focus:border-accent" /> : null}
              </div>
            </Rule>
            <Rule title="Company research" what="Dossier on the company, reused across its positions.">
              <div className="flex flex-wrap items-center gap-3">
                <Seg<AutopilotConfig["companyResearch"]["mode"]>
                  value={cfg.companyResearch.mode}
                  onChange={(mode) => set({ companyResearch: { ...cfg.companyResearch, mode } })}
                  options={[
                    { value: "off", label: "Never" },
                    { value: "on_evaluate", label: "When evaluating" },
                    { value: "on_pass", label: "On every PASS" },
                  ]}
                />
                <span className="text-[11.5px] text-muted inline-flex items-center gap-1.5">
                  refresh if older than <input type="number" min={1} value={cfg.companyResearch.staleDays} onChange={(e) => set({ companyResearch: { ...cfg.companyResearch, staleDays: Number(e.target.value) } })} className="w-[56px] h-7 rounded-md border border-border bg-bg px-2 text-[12px] font-mono text-right outline-none focus:border-accent" /> days
                </span>
              </div>
            </Rule>
            <Rule title="A JD changes materially" what="Re-read the JD and note what moved.">
              <Seg<AutopilotConfig["jdReview"]["mode"]>
                value={cfg.jdReview.mode}
                onChange={(mode) => set({ jdReview: { mode } })}
                options={[
                  { value: "off", label: "Never" },
                  { value: "hot_only", label: "Positions past triage" },
                  { value: "all_active", label: "Any open position" },
                ]}
              />
            </Rule>
            <Rule title="Evaluation scores well" what="Draft a tailored resume and cover. Always lands in the inbox as a draft.">
              <div className="flex flex-wrap items-center gap-3">
                <Seg<AutopilotConfig["materials"]["mode"]>
                  value={cfg.materials.mode}
                  onChange={(mode) => set({ materials: { ...cfg.materials, mode } })}
                  options={[
                    { value: "off", label: "Never" },
                    { value: "threshold", label: "Score ≥" },
                  ]}
                />
                {cfg.materials.mode === "threshold" ? <input type="number" step="0.1" min={0} max={5} value={cfg.materials.minEvaluateScore} onChange={(e) => set({ materials: { ...cfg.materials, minEvaluateScore: Number(e.target.value) } })} className="w-[64px] h-7 rounded-md border border-border bg-bg px-2 text-[12px] font-mono text-right outline-none focus:border-accent" /> : null}
              </div>
            </Rule>
            <Rule title="After an evaluation" what="Suggest apply / skip in the inbox. Nothing moves until you approve.">
              <Switch checked={cfg.suggestStatus} onChange={(v) => set({ suggestStatus: v })} label="File status suggestions" />
            </Rule>
          </div>
        </Panel>

        <div className="space-y-5">
          <Panel title="Daily budget" meta="hard stop, UTC day">
            <div className="space-y-3">
              <Input label="Max model calls (0 = no cap)" type="number" min={0} value={cfg.budget.dailyCalls} onChange={(e) => set({ budget: { ...cfg.budget, dailyCalls: Number(e.target.value) } })} />
              <Input label="Max tokens (0 = no cap)" type="number" min={0} value={cfg.budget.dailyTokens} onChange={(e) => set({ budget: { ...cfg.budget, dailyTokens: Number(e.target.value) } })} />
              <div className="pt-2 border-t border-border space-y-2">
                <Budget label="calls today" value={q.data.budgetToday.calls} limit={cfg.budget.dailyCalls} />
                <Budget label="tokens today" value={q.data.budgetToday.tokens} limit={cfg.budget.dailyTokens} />
              </div>
              <p className="text-[11px] text-faint">Per-operation caps live under AI models. The budget is the ceiling across all of them.</p>
            </div>
          </Panel>
          <Panel title="Last 24h">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-md bg-surface-2/70 py-2">
                <div className="font-display text-[20px] font-semibold tabular leading-none">{auto24}</div>
                <div className="eyebrow mt-1">auto jobs</div>
              </div>
              <Link to="/inbox" className="rounded-md bg-surface-2/70 py-2 hover:bg-surface-3">
                <div className={cn("font-display text-[20px] font-semibold tabular leading-none", summary.pendingApprovals ? "text-accent" : "")}>{summary.pendingApprovals}</div>
                <div className="eyebrow mt-1">in inbox</div>
              </Link>
            </div>
            {summary.untriaged ? <div className="text-[11.5px] text-warn mt-2">{summary.untriaged} positions are not scored yet.</div> : null}
          </Panel>
        </div>
      </div>
      <SaveBar dirty={dirty} onSave={save} label="Save as custom" />
    </div>
  );
}

function Rule({ title, what, children }: { title: string; what: string; children: ReactNode }) {
  return (
    <div className="grid sm:grid-cols-[220px_1fr] gap-x-4 gap-y-2 items-start">
      <div>
        <div className="text-[12.5px] font-medium flex items-center gap-1.5">
          <Zap className="h-3 w-3 text-faint" /> {title}
        </div>
        <div className="text-[11.5px] text-faint leading-snug mt-0.5">{what}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ---------------- Appearance ---------------- */

function AppearanceTab() {
  const theme = useTheme();
  const opts: { v: ThemePref; label: string; hint: string }[] = [
    { v: "dark", label: "Dark", hint: "Night desk. The default." },
    { v: "light", label: "Light", hint: "Cool paper, same amber signal." },
    { v: "system", label: "System", hint: "Follow the OS." },
  ];
  return (
    <div className="max-w-3xl space-y-4">
      <div className="grid sm:grid-cols-3 gap-3">
        {opts.map((o) => (
          <button key={o.v} type="button" onClick={() => theme.set(o.v)} className={cn("text-left rounded-lg border p-3 transition-colors", theme.pref === o.v ? "border-accent bg-accent/[0.06]" : "border-border bg-surface hover:border-border-strong")}>
            <Swatch mode={o.v === "system" ? theme.resolved : o.v} />
            <div className="font-medium text-[13px] mt-3">{o.label}</div>
            <div className="text-[11.5px] text-muted">{o.hint}</div>
          </button>
        ))}
      </div>
      <p className="text-[11.5px] text-faint">Toggle from the top bar any time. The preference is stored in this browser.</p>
    </div>
  );
}

function Swatch({ mode }: { mode: "dark" | "light" }) {
  const c = mode === "dark" ? { bg: "#0e1116", s: "#141920", b: "#232b37", t: "#e7eaf0", a: "#f2a93b" } : { bg: "#f3f4f7", s: "#ffffff", b: "#dfe3ea", t: "#171a20", a: "#b8730c" };
  return (
    <div className="rounded-md overflow-hidden border" style={{ background: c.bg, borderColor: c.b, height: 64 }}>
      <div className="flex h-full">
        <div style={{ width: 22, background: c.s, borderRight: `1px solid ${c.b}` }} />
        <div className="flex-1 p-2 space-y-1.5">
          <div style={{ height: 6, width: "60%", background: c.t, opacity: 0.85, borderRadius: 2 }} />
          <div style={{ height: 4, width: "80%", background: c.t, opacity: 0.35, borderRadius: 2 }} />
          <div className="flex gap-1 pt-1">
            {[1, 1, 1, 0.3, 0.3].map((o, i) => (
              <div key={i} style={{ height: 8, width: 4, background: c.a, opacity: o, borderRadius: 1 }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- System ---------------- */

function SystemTab() {
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { refetchInterval: 15_000 });
  const settings = useApi<Settings>(["settings"], "/api/v1/settings");
  const [jobStatus, setJobStatus] = useState("");
  const jobs = useApi<Job[]>(["system", "jobs", jobStatus], `/api/v1/settings/system/jobs${qs({ status: jobStatus, limit: 60 })}`, { refetchInterval: 10_000 });
  const tokens = useApi<ApiToken[]>(["tokens"], "/api/v1/settings/tokens");
  const qc = useQueryClient();
  const [ret, setRet] = useState<Settings["retention"] | null>(null);
  useEffect(() => {
    if (settings.data) setRet(settings.data.retention);
  }, [settings.data]);
  const [tokName, setTokName] = useState("");
  const [newTok, setNewTok] = useState<string | null>(null);

  async function saveRet() {
    await patch("/api/v1/settings", { retention: ret });
    void qc.invalidateQueries({ queryKey: ["settings"] });
    toast.success("Retention saved");
  }
  async function runRetention() {
    const r = await post<Record<string, number>>("/api/v1/settings/system/retention");
    toast.success(`Retention: ${Object.entries(r).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  async function enqueue(type: string) {
    await post("/api/v1/settings/system/jobs", { type });
    toast.success(`${type} queued`);
    void qc.invalidateQueries({ queryKey: ["system"] });
  }
  async function createToken() {
    const r = await post<{ token: string }>("/api/v1/settings/tokens", { name: tokName });
    setNewTok(r.token);
    setTokName("");
    void qc.invalidateQueries({ queryKey: ["tokens"] });
  }
  async function revoke(id: string) {
    await del(`/api/v1/settings/tokens/${id}`);
    void qc.invalidateQueries({ queryKey: ["tokens"] });
  }

  const stats = sys.data?.jobs || [];
  const by = (st: string) => stats.filter((j) => j.status === st).reduce((n, j) => n + j.count, 0);
  const br = sys.data?.browser;

  const clipJs = clipBookmarklet(window.location.origin);

  return (
    <div className="space-y-5">
      <Panel title="Job clipper" meta="bookmarklet">
        <p className="text-[12.5px] text-muted mb-3">
          Copy the snippet and paste it as a bookmark URL (Chrome blocks javascript: links on this page). Stay on the LinkedIn or Indeed listing, then click the bookmark — the tab text is POSTed so login-walled JDs survive. Session cookie only — no token in the bookmark.
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Btn
            onClick={() => {
              void navigator.clipboard.writeText(clipJs);
              toast.success("Bookmarklet copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </Btn>
        </div>
        <pre className="font-mono text-[10.5px] text-faint bg-surface-2 rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all">{clipJs}</pre>
      </Panel>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Fact label="version" value={`v${sys.data?.version ?? "…"}`} />
        <Fact label="auth" value={sys.data?.authMode ?? "…"} />
        <Fact label="LLM gateway" value={sys.data?.llmConfigured ? "connected" : "no key"} tone={sys.data?.llmConfigured ? "good" : "bad"} hint={sys.data?.llmBaseUrl} />
        <Fact
          label="job-scout Steel"
          value={!br?.configured ? "off" : br.ok ? "ready" : "unreachable"}
          tone={!br?.configured ? "faint" : br.ok ? "good" : "bad"}
          hint={br?.configured ? br.healthUrl || br.baseUrl || undefined : "set STEEL_BASE_URL (job-scout instance, not the shared browser)"}
          icon={<Globe className="h-3.5 w-3.5" />}
        />
      </div>

      <Panel
        title="Queue"
        meta={`${by("running")} running · ${by("queued")} queued · ${by("failed")} failed`}
        actions={
          <>
            <Btn size="xs" variant="ghost" onClick={() => post<{ enqueued: number }>("/api/v1/radar/boards/scan-all").then((r) => { const text = discoveryQueuedMessage(r); if (r.enqueued > 0) toast.success(text); else toast.message(text); })}>
              Discovery
            </Btn>
            <Btn size="xs" variant="ghost" onClick={() => enqueue("watch_check")}>
              Watches
            </Btn>
            <Btn size="xs" variant="ghost" onClick={runRetention}>
              Retention now
            </Btn>
          </>
        }
        flush
      >
        <div className="px-3 py-2 border-b border-border">
          <Seg<string>
            size="xs"
            value={jobStatus}
            onChange={setJobStatus}
            options={[
              { value: "", label: "Recent" },
              { value: "queued", label: "Queued", count: by("queued") },
              { value: "running", label: "Running", count: by("running"), tone: "accent" },
              { value: "failed", label: "Failed", count: by("failed"), tone: "bad" },
            ]}
          />
        </div>
        {jobs.data?.length ? (
          <Table className="border-0 rounded-none" dense>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Payload</Th>
                <Th right>Att</Th>
                <Th right>Created</Th>
                <Th right>Took</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <Tr key={j.id}>
                  <Td mono>{j.type}</Td>
                  <Td mono className={j.status === "failed" ? "text-bad" : j.status === "running" ? "text-accent" : j.status === "queued" ? "text-warn" : "text-muted"}>
                    {j.status}
                  </Td>
                  <Td mono className="text-muted max-w-[320px]">
                    <div className="truncate">{summarizePayload(j.payload)}</div>
                  </Td>
                  <Td right mono className="text-muted">
                    {j.attempts}
                  </Td>
                  <Td right mono className="text-muted">
                    {ago(j.createdAt)}
                  </Td>
                  <Td right mono className="text-muted">
                    {j.startedAt && j.finishedAt ? `${((new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000).toFixed(1)}s` : "—"}
                  </Td>
                  <Td className="max-w-[320px] text-bad text-[11px]">
                    <div className="truncate" title={j.error || ""}>
                      {j.error || ""}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-3 text-[12px] text-faint">No jobs.</div>
        )}
      </Panel>

      {ret ? (
        <Panel title="Retention">
          <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
            <Input label="Snapshots / board" type="number" value={ret.snapshotsKeep} onChange={(e) => setRet({ ...ret, snapshotsKeep: Number(e.target.value) })} />
            <Input label="Jobs (days)" type="number" value={ret.jobsDays} onChange={(e) => setRet({ ...ret, jobsDays: Number(e.target.value) })} />
            <Input label="Discovery (days)" type="number" value={ret.discoveryDays} onChange={(e) => setRet({ ...ret, discoveryDays: Number(e.target.value) })} />
            <Input label="Deltas (days)" type="number" value={ret.deltasDays} onChange={(e) => setRet({ ...ret, deltasDays: Number(e.target.value) })} />
            <Input label="LLM runs (days)" type="number" value={ret.llmRunsDays} onChange={(e) => setRet({ ...ret, llmRunsDays: Number(e.target.value) })} />
            <Btn variant="primary" size="md" onClick={saveRet}>
              Save
            </Btn>
          </div>
        </Panel>
      ) : null}

      <Panel title="API tokens" meta="MCP · career-ops sync">
        <div className="space-y-3">
          <div className="flex gap-2 items-end">
            <Input label="New token name" value={tokName} onChange={(e) => setTokName(e.target.value)} placeholder="career-ops-mac" />
            <Btn variant="primary" size="md" onClick={createToken} disabled={!tokName}>
              Create
            </Btn>
          </div>
          {newTok ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 p-2 text-[12px] flex items-center gap-2">
              <span className="font-mono break-all flex-1">{newTok}</span>
              <IconBtn
                label="Copy token"
                onClick={() => {
                  navigator.clipboard.writeText(newTok).then(() => toast.success("Copied")).catch(() => toast.error("Could not copy token"));
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </IconBtn>
              <span className="text-faint text-[11px]">shown once</span>
            </div>
          ) : null}
          {tokens.data?.length ? (
            <div className="divide-y divide-border/60 text-[12px]">
              {tokens.data.map((t) => (
                <div key={t.id} className={cn("flex items-center gap-3 py-1.5", t.revokedAt && "opacity-50")}>
                  <span className="font-medium">{t.name}</span>
                  <span className="font-mono text-faint">{t.tokenPrefix}…</span>
                  <span className="text-faint">{t.scopes?.join(", ")}</span>
                  <span className="text-faint ml-auto">{t.lastUsedAt ? `used ${ago(t.lastUsedAt)} ago` : "never used"}</span>
                  {t.revokedAt ? (
                    <span className="text-bad text-[11px]">revoked</span>
                  ) : (
                    <IconBtn label="Revoke token" onClick={() => revoke(t.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </IconBtn>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function Fact({ label, value, hint, tone, icon }: { label: string; value: string; hint?: string; tone?: "good" | "bad" | "faint"; icon?: ReactNode }) {
  return (
    <Card className="p-3">
      <div className="eyebrow flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      <div className={cn("font-mono text-[14px] mt-1.5", tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : tone === "faint" ? "text-faint" : "")}>{value}</div>
      {hint ? <div className="font-mono text-[10.5px] text-faint mt-0.5 truncate" title={hint}>{hint}</div> : null}
    </Card>
  );
}

function summarizePayload(p: Record<string, unknown>) {
  return Object.entries(p)
    .filter(([k]) => k !== "force")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
}
