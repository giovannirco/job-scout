import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, Check, Eye, EyeOff, ExternalLink, FileText, MessageSquareText, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GeoChip, ListingBadge, ScoreMeter, STATUS_LABEL, STATUS_PATH, STATUS_TERMINAL, STATUS_TONE, verdictTone } from "@/components/badges";
import { InterviewRoundBody } from "@/components/interview-round";
import { Markdown } from "@/components/markdown";
import { StatusMenu, useStatusChange } from "@/components/status-menu";
import { openDock, useChatScope } from "@/frame/store";
import { INTERVIEW_OUTCOMES, INTERVIEW_STAGES, INTERVIEW_STATUSES, changeKindLabel, humanDiffSummary, isCompanyNameLocation } from "@job-scout/shared";
import { api, del, patch, post, qs, useApi, type Evaluation, type Interview, type Material, type Person, type PipelineStatus, type PositionDetail, type Profile, type Revision, type SystemInfo, type TimelineEvent, type TriageJson } from "@/lib/api";
import { ago, createdFromLabel, dateShort, dateTime, employmentLabel, host, jdChangedAt, money, questionStatusLabel, titleCase } from "@/lib/format";
import { Btn, Card, Chip, Dot, Empty, ErrorNote, Field, IconBtn, Input, Loading, Monogram, Page, Panel, Select, SortHead, Tabs, Textarea, TONE_DOT, TONE_TEXT, cn } from "@/ui/kit";

type Tab = "brief" | "evaluation" | "jd" | "materials" | "forms" | "company" | "history";

function sourceLocation(p: PositionDetail): string | null {
  const loc = (p.locationRaw || p.revisions[0]?.locationRaw || "").trim();
  if (!loc) return null;
  if (isCompanyNameLocation(loc, p.company.name)) return null;
  return loc;
}

export function PositionPage() {
  const { id } = useParams({ from: "/positions/$id" });
  const search = useSearch({ from: "/positions/$id" });
  const navigate = useNavigate({ from: "/positions/$id" });
  const tab = (search.tab as Tab) || "brief";
  const setTab = (t: Tab) => navigate({ search: { tab: t === "brief" ? undefined : t }, replace: true });

  const [pendingUntil, setPendingUntil] = useState<number>(0);
  const polling = pendingUntil > Date.now();
  const q = useApi<PositionDetail>(["position", id], `/api/v1/positions/${id}`, { refetchInterval: polling ? 4000 : false });
  const sys = useApi<SystemInfo>(["system"], "/api/v1/settings/system", { staleTime: 30_000 });
  const profile = useApi<Profile>(["profile"], "/api/v1/settings/profile", { staleTime: 30_000 });
  const noKey = sys.data?.llmConfigured === false;
  const p = q.data;
  const qc = useQueryClient();
  const pollingKey = useRef<string | null>(null);

  useChatScope(p ? { scope: "position", positionId: p.id, slug: p.slug, label: `${p.company.name} · ${p.title}` } : null);

  useEffect(() => {
    if (!polling || !p) return;
    const key = `${p.evaluations.length}:${p.materials.length}:${p.triagedAt}:${p.updatedAt}`;
    if (pollingKey.current && pollingKey.current !== key) {
      setPendingUntil(0);
      pollingKey.current = null;
      toast.success("Done");
      void qc.invalidateQueries({ queryKey: ["today"] });
    }
    // Run when the selected position changes, not when its query result refreshes.
  }, [p?.evaluations.length, p?.materials.length, p?.triagedAt, p?.updatedAt, polling]);

  async function runAction(action: string, body: Record<string, unknown> = {}) {
    if (!p) return;
    if (noKey) {
      toast.message("Add a model key in Settings before this can run.");
      return;
    }
    try {
      pollingKey.current = `${p.evaluations.length}:${p.materials.length}:${p.triagedAt}:${p.updatedAt}`;
      const r = await post<{ jobId: string; deduped: boolean }>(`/api/v1/positions/${p.id}/actions/${action}`, body);
      toast(r.deduped ? `${titleCase(action)} already queued` : `${titleCase(action)} queued`);
      setPendingUntil(Date.now() + 4 * 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  async function refreshJd() {
    if (!p) return;
    try {
      const r = await post<{ changed: boolean; listingStatus?: string }>(`/api/v1/positions/${p.id}/refresh`);
      toast.success(r.changed ? "JD changed — new revision recorded" : "No change");
      void qc.invalidateQueries({ queryKey: ["position", id] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  async function toggleWatch() {
    if (!p) return;
    await patch(`/api/v1/positions/${p.id}`, { watchEnabled: !p.watchEnabled });
    void qc.invalidateQueries({ queryKey: ["position", id] });
  }

  async function archive() {
    if (!p) return;
    const reason = window.prompt("Archive reason (optional)", "manual");
    if (reason === null) return;
    await post(`/api/v1/positions/${p.id}/archive`, { reason });
    void qc.invalidateQueries({ queryKey: ["position", id] });
    void qc.invalidateQueries({ queryKey: ["positions"] });
    toast("Archived");
  }

  if (q.isLoading) return <Page><Loading rows={6} /></Page>;
  if (q.isError) return <Page><ErrorNote error={q.error} /></Page>;
  if (!p) return <Page><Empty>Position not found.</Empty></Page>;

  const hasEval = p.evaluations.some((e) => e.kind === "evaluate");
  const hasJdReview = p.evaluations.some((e) => e.kind === "jd_review");
  const hasResearch = p.evaluations.some((e) => e.kind === "company_research");
  const comp = money(p.salaryMin, p.salaryMax, p.salaryCurrency) || p.salaryRaw;
  const loc = sourceLocation(p);

  return (
    <Page wide>
      {/* header */}
      {p.triageStale ? <Card className="p-3 text-sm">This score predates the current profile or has no recorded profile version. Re-run triage to use the current experience and targeting.</Card> : null}
      {p.repostOfId ? <Card className="p-3 text-sm"><Link to="/positions/$id" params={{ id: p.repostOfId }} className="underline">Possible repost of a previous role</Link>{p.repost?.appliedAt ? ` · applied ${dateShort(p.repost.appliedAt)}` : ""}. Review the prior history before applying.</Card> : null}
      {(p.siblings?.length || 0) > 1 ? <Card className="p-3 text-sm"><details><summary>{p.siblings!.length} related postings</summary><ul className="mt-2 space-y-1">{p.siblings!.map(s => <li key={s.id}><Link to="/positions/$id" params={{ id: s.id }} className="underline">{s.location || s.title}</Link> · {s.status}{s.url ? <> · <a href={s.url} target="_blank" rel="noreferrer" className="underline">Posting</a></> : null}</li>)}</ul></details></Card> : null}
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-4 flex-wrap">
          <Monogram name={p.company.name} size={48} className="rounded-lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[12.5px] flex-wrap">
              <Link to="/companies/$id" params={{ id: p.company.slug }} className="font-medium hover:underline">
                {p.company.name}
              </Link>
              {p.primaryUrl ? (
                <a href={p.primaryUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-fg">
                  {p.atsProvider && p.atsProvider !== "unknown" ? p.atsProvider : host(p.primaryUrl)} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
              <ListingBadge status={p.listingStatus} />
              {p.watchEnabled ? <Chip tone="faint">watched</Chip> : null}
            </div>
            <h1 className="font-display text-[24px] leading-[1.15] font-semibold tracking-[-0.01em] mt-0.5">{p.title || <span className="text-faint">Untitled</span>}</h1>
            <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1.5 text-[12px] text-muted">
              <GeoChip geo={p.geoClass} remote={p.remoteClass} location={loc} home={profile.data?.location} />
              {loc ? <span className="max-w-[420px] truncate" title={loc}>{loc}</span> : null}
              {comp ? <span className="font-mono text-[11.5px] text-fg" title={p.salaryRaw || undefined}>{comp}</span> : null}
              {p.employmentType ? <span>{employmentLabel(p.employmentType)}</span> : null}
              {p.craftFamily ? <span>{titleCase(p.craftFamily)}</span> : null}
              <span className="font-mono text-[11px] text-faint tabular">
                seen {ago(p.firstSeenAt)}
                {jdChangedAt(p.firstSeenAt, p.lastChangedAt) ? ` · changed ${ago(p.lastChangedAt)}` : ""}
                {p.appliedAt ? ` · applied ${ago(p.appliedAt)}` : ""}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <div className="flex items-center gap-2">
              {polling ? (
                <span className="font-mono text-[11px] text-accent inline-flex items-center gap-1.5">
                  <Dot tone="accent" pulse /> working
                </span>
              ) : null}
              <Btn variant={hasEval ? "default" : "primary"} disabled={noKey} onClick={() => runAction("evaluate")} title={noKey ? "Add a model key in Settings" : "Full A–H evaluation with the configured model"}>
                <Sparkles className="h-3.5 w-3.5" /> {hasEval ? "Re-evaluate" : "Evaluate"}
              </Btn>
              <Btn disabled={noKey} onClick={() => runAction("materials")} title={noKey ? "Add a model key in Settings" : "Tailored resume + cover for this position"}>
                <FileText className="h-3.5 w-3.5" /> Materials
              </Btn>
              <IconBtn label="Chat about this position" disabled={noKey} title={noKey ? "Add a model key in Settings" : "Chat about this position"} onClick={() => openDock("chat")}>
                <MessageSquareText className="h-4 w-4" />
              </IconBtn>
              <IconBtn label="Fetch the JD again" onClick={refreshJd}>
                <RefreshCw className="h-3.5 w-3.5" />
              </IconBtn>
              <IconBtn label={p.watchEnabled ? "Stop watching" : "Watch for JD changes"} onClick={toggleWatch} active={p.watchEnabled}>
                {p.watchEnabled ? <Eye className="h-3.5 w-3.5 text-accent" /> : <EyeOff className="h-3.5 w-3.5" />}
              </IconBtn>
              {p.status !== "archived" ? (
                <IconBtn label="Archive" onClick={archive}>
                  <Archive className="h-3.5 w-3.5" />
                </IconBtn>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <ScoreMeter score={p.triageScore} verdict={p.triageVerdict} size="md" />
              {p.triageVerdict ? <span className={cn("font-mono text-[11px] uppercase", TONE_TEXT[verdictTone(p.triageVerdict)])}>{p.triageVerdict}</span> : <span className="font-mono text-[11px] text-faint">not scored</span>}
            </div>
          </div>
        </div>

        <Stepper id={p.id} status={p.status} archiveReason={p.archiveReason} />
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        options={[
          { value: "brief", label: "Brief" },
          { value: "evaluation", label: "Evaluation", count: p.evaluations.filter((e) => e.kind !== "company_research").length || null },
          { value: "jd", label: "JD", count: p.revisions.filter((r) => r.revision > 1 && r.material).length || null, tone: p.revisions.some((r) => r.material && r.revision > 1) ? "warn" : undefined },
          { value: "materials", label: "Materials", count: p.materials.filter((m) => m.isCurrent).length || null },
          { value: "forms", label: "Forms" },
          { value: "company", label: "Company" },
          { value: "history", label: "History" },
        ]}
      />

      {tab === "brief" ? <BriefTab p={p} noKey={noKey} onTriage={() => runAction("triage", { force: true })} /> : null}
      {tab === "evaluation" ? <EvaluationTab p={p} hasEval={hasEval} hasJdReview={hasJdReview} noKey={noKey} onRun={runAction} /> : null}
      {tab === "jd" ? <JdTab p={p} /> : null}
      {tab === "materials" ? <MaterialsTab p={p} noKey={noKey} onRun={runAction} /> : null}
      {tab === "forms" ? <FormsTab p={p} noKey={noKey} onDraft={() => runAction("form_answers")} /> : null}
      {tab === "company" ? <CompanyTab p={p} hasResearch={hasResearch} noKey={noKey} onRun={runAction} /> : null}
      {tab === "history" ? <HistoryTab p={p} /> : null}
    </Page>
  );
}

/* ---------------- Stepper ---------------- */

function Stepper({ id, status, archiveReason }: { id: string; status: PipelineStatus; archiveReason: string | null }) {
  const m = useStatusChange();
  const idx = STATUS_PATH.indexOf(status);
  const terminal = STATUS_TERMINAL.includes(status);
  const move = (s: PipelineStatus) => {
    if (s === status) return;
    m.mutateAsync({ id, status: s })
      .then(() => toast.success(`Moved to ${STATUS_LABEL[s]}`))
      .catch((e) => toast.error(e.message));
  };
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <ol className="flex items-center rounded-lg border border-border bg-surface overflow-hidden flex-1 min-w-[520px]">
        {STATUS_PATH.map((s, i) => {
          const done = !terminal && i < idx;
          const here = s === status;
          const tone = STATUS_TONE[s];
          return (
            <li key={s} className="flex-1 min-w-0">
              <button
                type="button"
                onClick={() => move(s)}
                title={`Move to ${STATUS_LABEL[s]}`}
                className={cn(
                  "relative w-full h-9 flex items-center justify-center gap-1.5 text-[11.5px] border-r border-border last:border-r-0 transition-colors",
                  here ? "bg-surface-3 text-fg font-medium" : done ? "text-muted hover:bg-surface-2" : "text-faint hover:text-fg hover:bg-surface-2",
                )}
              >
                {here ? <span className={cn("absolute inset-x-0 top-0 h-[2px]", TONE_DOT[tone])} /> : null}
                {done ? <Check className="h-3 w-3 text-good" /> : <span className={cn("h-1.5 w-1.5 rounded-full", here ? TONE_DOT[tone] : "bg-border-strong")} />}
                <span className="truncate">{STATUS_LABEL[s]}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-1.5">
        {terminal ? (
          <StatusMenu id={id} value={status} size="md" align="right" />
        ) : (
          <>
            <Btn size="xs" variant="ghost" onClick={() => move("skip")}>
              {STATUS_LABEL.skip}
            </Btn>
            <Btn size="xs" variant="ghost" onClick={() => move("rejected")}>
              Rejected
            </Btn>
          </>
        )}
      </div>
      {status === "archived" && archiveReason ? <span className="text-[11.5px] text-faint w-full">Archived: {archiveReason}</span> : null}
    </div>
  );
}

/* ---------------- Brief ---------------- */

function BriefTab({ p, noKey, onTriage }: { p: PositionDetail; noKey: boolean; onTriage: () => void }) {
  const t = p.triageJson;
  const qc = useQueryClient();
  const [notes, setNotes] = useState(p.notes || "");
  const [next, setNext] = useState(p.nextAction || "");
  useEffect(() => {
    setNotes(p.notes || "");
    setNext(p.nextAction || "");
  }, [p.notes, p.nextAction]);

  async function save() {
    await patch(`/api/v1/positions/${p.id}`, { notes: notes || null, nextAction: next || null });
    void qc.invalidateQueries({ queryKey: ["position", p.slug] });
    void qc.invalidateQueries({ queryKey: ["position", p.id] });
    toast.success("Saved");
  }
  const comp = money(p.salaryMin, p.salaryMax, p.salaryCurrency) || p.salaryRaw;
  const latestEval = p.evaluations.find((e) => e.kind === "evaluate");
  const ej = (latestEval?.json || null) as null | { score?: number; verdict?: string; headline?: string };
  const loc = sourceLocation(p);

  return (
    <div className="grid lg:grid-cols-[1fr_320px] gap-5 items-start">
      <div className="space-y-5 min-w-0">
        <Panel
          title="Triage"
          meta={t?.model ? t.model : undefined}
          actions={
            <Btn size="xs" variant="ghost" disabled={noKey} onClick={onTriage} title={noKey ? "Add a model key in Settings" : undefined}>
              <RefreshCw className="h-3 w-3" /> {t ? "Re-triage" : "Triage now"}
            </Btn>
          }
        >
          {!t ? (
            <Empty>
              {noKey ? (
                <>No model key is set, so this role is not scored. <Link to="/settings" search={{ tab: "ai" }} className="text-accent hover:underline">Add one in Settings</Link>.</>
              ) : (
                "Not triaged yet. It is queued, or triage is off in Settings › AI."
              )}
            </Empty>
          ) : <TriageCard t={t} />}
        </Panel>

        {ej ? (
          <Panel title="Evaluation" meta={latestEval ? dateTime(latestEval.createdAt) : undefined}>
            <div className="flex items-start gap-4">
              <div className="font-display text-[34px] font-semibold tabular leading-none">{ej.score != null ? ej.score.toFixed(1) : "—"}</div>
              <div className="min-w-0">
                {ej.verdict ? <Chip tone={ej.verdict === "apply" ? "good" : ej.verdict === "consider" ? "warn" : "bad"}>{ej.verdict}</Chip> : null}
                {ej.headline ? <div className="text-[12.5px] leading-snug mt-1">{ej.headline}</div> : null}
              </div>
            </div>
          </Panel>
        ) : null}

        {p.jd?.descriptionText ? (
          <Panel title="Job description" meta={`rev ${p.jd.revision}`} bodyClass="max-h-[520px] overflow-y-auto">
            <div className="prewrap text-[12.5px] text-fg/90 leading-relaxed">{p.jd.descriptionText}</div>
          </Panel>
        ) : null}
      </div>

      <div className="space-y-5 min-w-0">
        <Panel title="Facts">
          <div className="space-y-1.5">
            <Field label="Employment">{employmentLabel(p.employmentType) || "—"}</Field>
            <Field label="Workplace">{p.workplace && p.workplace !== "unknown" ? p.workplace : "—"}</Field>
            {loc ? <Field label="Location">{loc}</Field> : null}
            <Field label="Geo">
              {p.geoClass && p.geoClass !== "unknown"
                ? p.geoClass.replace(/_/g, " ").replace("worldwideish", "worldwide")
                : "—"}
            </Field>
            {p.departments?.length ? <Field label="Team">{p.departments.join(" · ")}</Field> : null}
            {p.geoNotes ? <Field label="Geo notes">{p.geoNotes}</Field> : null}
            <Field label="Comp">{comp || "—"}</Field>
            {p.equityNotes ? <Field label="Equity">{p.equityNotes}</Field> : null}
            <Field label="Craft">{titleCase(p.craftFamily) || "—"}</Field>
            <Field label="Source">{p.source || "—"}</Field>
            <Field label="Surface">{p.resumeSurface || "—"}</Field>
            {p.jd?.techTags?.length ? (
              <Field label="Stack">
                <div className="flex flex-wrap gap-1">
                  {p.jd.techTags.slice(0, 24).map((x) => (
                    <span key={x} className="font-mono text-[10.5px] bg-surface-2 rounded px-1">
                      {x}
                    </span>
                  ))}
                </div>
              </Field>
            ) : null}
            <Field label="ATS id">
              <span className="font-mono text-[11px]">{p.atsJobId || p.externalIdentity || "—"}</span>
            </Field>
            {p.postedAt ? (
              <Field label="Posted">
                {dateShort(p.postedAt)} · {ago(p.postedAt)} ago
              </Field>
            ) : null}
            <Field label="Checked">{ago(p.lastCheckedAt)} ago</Field>
            {p.closedAt ? <Field label="Closed">{dateTime(p.closedAt)}</Field> : null}
          </div>
        </Panel>

        <Panel title="Notes">
          <div className="space-y-2">
            <Textarea label="Next action" value={next} onChange={(e) => setNext(e.target.value)} className="min-h-[40px]" placeholder="e.g. ping recruiter Friday" />
            <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything that does not fit a field" />
            <div className="flex justify-end">
              <Btn variant="primary" onClick={save} disabled={notes === (p.notes || "") && next === (p.nextAction || "")}>
                Save
              </Btn>
            </div>
          </div>
        </Panel>

        <ContactsPanel positionId={p.id} />
        <InterviewsPanel positionId={p.id} noKey={noKey} />

        <CareerOpsStamp p={p} />
      </div>
    </div>
  );
}

function TriageCard({ t }: { t: TriageJson }) {
  const dims: { k: keyof TriageJson; label: string; note?: string }[] = [
    { k: "archetype", label: "Archetype", note: t.archetypeLabel },
    { k: "comp", label: "Comp", note: t.compNote },
    { k: "location", label: "Location", note: t.locationNote },
    { k: "cvMatch", label: "CV match" },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-4">
        <div className="font-display text-[34px] font-semibold tabular leading-none">{t.score.toFixed(1)}</div>
        <div className="text-[12.5px] leading-snug pt-1">{t.oneLiner}</div>
      </div>
      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
        {dims.map((d) => {
          const v = t[d.k] as number;
          return (
            <div key={d.k} className="text-[12px]">
              <div className="flex items-center justify-between">
                <span className="text-muted">{d.label}</span>
                <span className="font-mono tabular">{v}/5</span>
              </div>
              <div className="h-1 rounded bg-surface-3 mt-1">
                <div className={cn("h-1 rounded", v >= 4 ? "bg-good" : v >= 3 ? "bg-warn" : "bg-bad")} style={{ width: `${(v / 5) * 100}%` }} />
              </div>
              {d.note ? <div className="text-[11px] text-faint mt-0.5">{d.note}</div> : null}
            </div>
          );
        })}
      </div>
      {t.hardDq.length ? (
        <div className="text-[12px] rounded-md border border-bad/30 bg-bad/5 px-2.5 py-1.5">
          <span className="text-bad font-medium">Hard DQ:</span> {t.hardDq.join(" · ")}
        </div>
      ) : null}
      {t.softFlags.length ? (
        <div className="text-[12px]">
          <span className="text-warn font-medium">Flags:</span> {t.softFlags.join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

function CareerOpsStamp({ p }: { p: PositionDetail }) {
  const stamp = (p.metadata?.careerOps || null) as null | { trackerId?: string; status?: string; score?: number; reportPath?: string; pdfPath?: string; stampedAt?: string; syncedAt?: string };
  if (!stamp) return null;
  return (
    <Panel title="career-ops">
      <div className="space-y-1">
        {stamp.trackerId ? <Field label="Tracker">#{stamp.trackerId}</Field> : null}
        {stamp.status ? <Field label="Status">{stamp.status}</Field> : null}
        {stamp.score != null ? <Field label="Score">{stamp.score}</Field> : null}
        {stamp.reportPath ? (
          <Field label="Report">
            <span className="font-mono text-[11px] break-all">{stamp.reportPath}</span>
          </Field>
        ) : null}
        {stamp.stampedAt || stamp.syncedAt ? <Field label="Synced">{ago(stamp.stampedAt || stamp.syncedAt)} ago</Field> : null}
      </div>
    </Panel>
  );
}

/* ---------------- Evaluation ---------------- */

function EvaluationTab({ p, hasEval, hasJdReview, noKey, onRun }: { p: PositionDetail; hasEval: boolean; hasJdReview: boolean; noKey: boolean; onRun: (a: string) => void }) {
  const evals = p.evaluations.filter((e) => e.kind === "evaluate");
  const reviews = p.evaluations.filter((e) => e.kind === "jd_review");
  const [sel, setSel] = useState<string | null>(null);
  const current = sel || evals[0]?.id || reviews[0]?.id || null;
  const e = useApi<Evaluation>(["evaluation", current], `/api/v1/positions/${p.id}/evaluations/${current}`, { enabled: Boolean(current) });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {[...evals, ...reviews].map((x) => (
          <button key={x.id} type="button" onClick={() => setSel(x.id)} className={cn("rounded-md border px-2 h-7 text-[11.5px] font-mono", current === x.id ? "border-accent text-fg bg-surface-2" : "border-border text-muted hover:text-fg")}>
            {x.kind === "evaluate" ? "A–H" : "JD review"} · {dateTime(x.createdAt)} · {x.model || "?"}
          </button>
        ))}
        <span className="ml-auto flex gap-2">
          <Btn variant="ghost" disabled={noKey} title={noKey ? "Add a model key in Settings" : undefined} onClick={() => onRun("jd_review")}>
            {hasJdReview ? "Re-run JD review" : "JD review"}
          </Btn>
          <Btn variant={hasEval ? "default" : "primary"} disabled={noKey} title={noKey ? "Add a model key in Settings" : undefined} onClick={() => onRun("evaluate")}>
            <Sparkles className="h-3.5 w-3.5" /> {hasEval ? "Re-evaluate" : "Evaluate"}
          </Btn>
        </span>
      </div>
      {!current ? (
        <Empty>No evaluation yet. Evaluate runs the full A–H report against your master resume.</Empty>
      ) : e.isLoading ? (
        <Loading rows={6} />
      ) : e.data ? (
        <Card className="p-5 max-w-4xl">
          <Markdown>{e.data.markdown || "_empty_"}</Markdown>
          <div className="text-[10.5px] text-faint font-mono mt-5 pt-3 border-t border-border">
            {e.data.model} · {e.data.tokensIn ?? "?"}→{e.data.tokensOut ?? "?"} tok · {e.data.latencyMs ? `${(e.data.latencyMs / 1000).toFixed(1)}s` : ""}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* ---------------- JD ---------------- */

function JdTab({ p }: { p: PositionDetail }) {
  const [rev, setRev] = useState<number | null>(null);
  const currentRev = rev ?? p.revisions[0]?.revision ?? null;
  const r = useApi<Revision>(["revision", p.id, currentRev], `/api/v1/positions/${p.id}/revisions/${currentRev}`, { enabled: currentRev != null });

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-5 items-start">
      <Panel title="Revisions" meta={`${p.revisions.length}`} flush>
        <div className="divide-y divide-border/60">
          {p.revisions.map((x) => (
            <button key={x.id} type="button" onClick={() => setRev(x.revision)} className={cn("w-full text-left px-3 py-2 text-[12px] hover:bg-surface-2/60", currentRev === x.revision && "bg-surface-2")}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono inline-flex items-center gap-1.5">
                  <Dot tone={x.changeKind === "closed" ? "bad" : x.material ? "warn" : "faint"} />r{x.revision} · {changeKindLabel(x.changeKind)}
                </span>
                <span className="text-faint font-mono text-[10.5px] tabular">{dateTime(x.observedAt)}</span>
              </div>
              {x.diffSummary ? <div className="text-[11px] text-muted line-clamp-2 mt-0.5">{humanDiffSummary(x.diffSummary)}</div> : null}
            </button>
          ))}
          {p.revisions.length === 0 ? <div className="p-3 text-faint text-xs">No JD captured yet.</div> : null}
        </div>
      </Panel>
      <Panel title={`Revision ${currentRev ?? "—"}`} meta={r.data?.observedAt ? dateTime(r.data.observedAt) : undefined}>
        {r.isLoading ? (
          <Loading rows={6} />
        ) : r.data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted font-mono">
              {r.data.title ? <span>{r.data.title}</span> : null}
              {r.data.locationRaw ? <span>{r.data.locationRaw}</span> : null}
              {r.data.salaryRaw ? <span>{r.data.salaryRaw}</span> : null}
            </div>
            {r.data.fieldDiffs?.length ? (
              <div className="rounded-md border border-border bg-bg divide-y divide-border/60 text-[11.5px]">
                {r.data.fieldDiffs.slice(0, 30).map((d, i) => (
                  <div key={i} className="grid grid-cols-[110px_1fr_1fr] gap-2 px-2 py-1">
                    <span className="font-mono text-faint">{humanDiffSummary(d.path)}</span>
                    <span className="text-bad/80 line-through break-words">{d.before || "∅"}</span>
                    <span className="text-good break-words">{d.after || "∅"}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="prewrap text-[12.5px] text-fg/90 leading-relaxed">{r.data.descriptionText || <span className="text-faint">No text.</span>}</div>
          </div>
        ) : (
          <Empty>No JD text.</Empty>
        )}
      </Panel>
    </div>
  );
}

/* ---------------- Materials ---------------- */

function MaterialsTab({ p, noKey, onRun }: { p: PositionDetail; noKey: boolean; onRun: (a: string, body?: Record<string, unknown>) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const current = sel || p.materials.find((m) => m.isCurrent && m.kind === "resume")?.id || p.materials[0]?.id || null;
  const m = useApi<Material>(["material", current], `/api/v1/positions/materials/${current}`, { enabled: Boolean(current) });

  return (
    <div className="grid lg:grid-cols-[280px_1fr] gap-5 items-start">
      <Panel
        title="Versions"
        actions={
          <Btn size="xs" variant="primary" disabled={noKey} title={noKey ? "Add a model key in Settings" : undefined} onClick={() => onRun("materials")}>
            <FileText className="h-3 w-3" /> Generate
          </Btn>
        }
        flush
      >
        <div className="divide-y divide-border/60">
          {p.materials.map((x) => (
            <button key={x.id} type="button" onClick={() => setSel(x.id)} className={cn("w-full text-left px-3 py-2 text-[12px] hover:bg-surface-2/60", current === x.id && "bg-surface-2")}>
              <div className="flex items-center justify-between">
                <span className="font-mono">
                  {x.kind} v{x.version}
                  {x.isCurrent ? <span className="text-accent"> ●</span> : null}
                </span>
                <span className="text-faint font-mono text-[10.5px] tabular">{dateTime(x.createdAt)}</span>
              </div>
              <div className="text-[11px] text-muted">
                {x.status}
                {x.model ? ` · ${x.model}` : ""}
                {x.hasPdf ? " · pdf" : ""}
              </div>
            </button>
          ))}
          {p.materials.length === 0 ? <div className="p-3 text-faint text-xs">No materials yet.</div> : null}
        </div>
      </Panel>
      <Panel title={m.data ? `${m.data.kind} v${m.data.version}` : "Material"}>
        {!current ? (
          <Empty>Generate builds a tailored resume and cover letter from your master resume and this JD.</Empty>
        ) : m.isLoading ? (
          <Loading rows={6} />
        ) : m.data ? (
          <div>
            {m.data.title ? <div className="font-display text-[15px] font-semibold mb-2">{m.data.title}</div> : null}
            <Markdown>{m.data.bodyMarkdown || "_empty_"}</Markdown>
            {m.data.notes ? <div className="text-[11.5px] text-muted mt-3 border-t border-border pt-2">{m.data.notes}</div> : null}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

/* ---------------- Company ---------------- */

function CompanyTab({ p, hasResearch, noKey, onRun }: { p: PositionDetail; hasResearch: boolean; noKey: boolean; onRun: (a: string) => void }) {
  const research = p.evaluations.find((e) => e.kind === "company_research");
  const e = useApi<Evaluation>(["evaluation", research?.id], `/api/v1/positions/${p.id}/evaluations/${research?.id}`, { enabled: Boolean(research) });
  return (
    <div className="space-y-3 max-w-4xl">
      <Card className="p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
        <Monogram name={p.company.name} size={28} />
        <Link to="/companies/$id" params={{ id: p.company.slug }} className="font-medium hover:underline">
          {p.company.name}
        </Link>
        {p.company.website ? (
          <a href={p.company.website} target="_blank" rel="noreferrer" className="text-muted hover:text-fg">
            {host(p.company.website)}
          </a>
        ) : null}
        {p.company.careersUrl ? (
          <a href={p.company.careersUrl} target="_blank" rel="noreferrer" className="text-muted hover:text-fg">
            careers
          </a>
        ) : null}
        {p.company.industryTags?.length ? <span className="text-faint font-mono text-[11px]">{p.company.industryTags.join(" · ")}</span> : null}
        <span className="ml-auto">
          <Btn variant={hasResearch ? "default" : "primary"} disabled={noKey} title={noKey ? "Add a model key in Settings" : undefined} onClick={() => onRun("company_research")}>
            <Sparkles className="h-3.5 w-3.5" /> {hasResearch ? "Refresh research" : "Research company"}
          </Btn>
        </span>
      </Card>
      {p.company.overview ? <Card className="p-3 text-[12.5px] leading-relaxed">{p.company.overview}</Card> : null}
      {!research ? (
        <Empty>No research yet. Research builds a dossier: product, funding, culture signals, remote stance.</Empty>
      ) : e.data ? (
        <Card className="p-5">
          <Markdown>{e.data.markdown || "_empty_"}</Markdown>
          <div className="text-[10.5px] text-faint font-mono mt-5 pt-3 border-t border-border">
            {e.data.model} · {dateTime(e.data.createdAt)}
          </div>
        </Card>
      ) : (
        <Loading rows={6} />
      )}
    </div>
  );
}

/* ---------------- History ---------------- */

function HistoryTab({ p }: { p: PositionDetail }) {
  const t = useApi<TimelineEvent[]>(["timeline", p.id], `/api/v1/positions/${p.id}/timeline?limit=200`);
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  async function addNote() {
    if (!note.trim()) return;
    await api(`/api/v1/positions/${p.id}/notes`, { method: "POST", body: JSON.stringify({ title: "Note", body: note.trim() }) });
    setNote("");
    void qc.invalidateQueries({ queryKey: ["timeline", p.id] });
  }
  return (
    <div className="space-y-3 max-w-3xl">
      <Card className="p-3 flex gap-2 items-end">
        <Textarea label="Add a note" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-[40px] flex-1" />
        <Btn variant="primary" onClick={addNote} disabled={!note.trim()}>
          Add
        </Btn>
      </Card>
      {t.isLoading ? (
        <Loading rows={6} />
      ) : (
        <ol className="relative border-l border-border ml-[52px] space-y-0">
          {(t.data || []).map((e) => (
            <li key={e.id} className="relative pl-5 py-2">
              <span className="absolute -left-[5px] top-[15px] h-[9px] w-[9px] rounded-full bg-surface border-2 border-border-strong" />
              <div className="absolute -left-[60px] top-[11px] w-[48px] text-right font-mono text-[10px] text-faint tabular leading-tight">{dateTime(e.occurredAt).replace(",", "\n")}</div>
              <div className="flex items-center gap-2 text-[12.5px]">
                <span className="font-mono text-[10px] uppercase text-muted">{e.kind}</span>
                <span>{createdFromLabel(e.title)}</span>
                {e.actor && e.actor !== "system" ? <span className="text-faint text-[11px]">· {e.actor}</span> : null}
              </div>
              {e.body ? <div className="text-[12px] text-muted prewrap mt-0.5">{e.body}</div> : null}
            </li>
          ))}
          {t.data?.length === 0 ? <li className="pl-5 py-3 text-faint text-xs">No events.</li> : null}
        </ol>
      )}
    </div>
  );
}

type FormQuestion = {
  id: string;
  question: string;
  answer: string | null;
  required: boolean;
  inputType: string | null;
  status: string;
};

function FormsTab({ p, noKey, onDraft }: { p: PositionDetail; noKey: boolean; onDraft: () => void }) {
  const qc = useQueryClient();
  const search = useSearch({ from: "/positions/$id" });
  const navigate = useNavigate({ from: "/positions/$id" });
  const id = p.id;
  const harvestError = (p.metadata as { forms?: { harvestError?: string } } | null)?.forms?.harvestError;
  const questionKey = ["position", id, "questions", search.sort];
  const q = useApi<FormQuestion[]>(questionKey, `/api/v1/positions/${id}/questions${qs({ sort: search.sort })}`);
  if (q.isLoading) return <Loading rows={5} />;
  const rows = q.data || [];
  return (
    <div className="space-y-3 max-w-3xl">
      {harvestError && !rows.length ? (
        <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[12.5px] text-warn">could not fetch form</div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[12.5px] text-muted">{rows.length ? `${rows.length} application questions` : "No form harvested yet. Refresh the JD or wait for a renderer."}</div>
        <div className="flex items-center gap-2">
          <SortHead label="Question" field="question" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, tab: "forms" }) })} />
          <SortHead label="Status" field="status" sort={search.sort} onSort={(n) => navigate({ search: (prev) => ({ ...prev, sort: n, tab: "forms" }) })} />
          <Btn variant="primary" onClick={onDraft} disabled={!rows.length || noKey} title={noKey ? "Add a model key in Settings" : undefined}>
            <Sparkles className="h-3.5 w-3.5" /> Draft answers
          </Btn>
        </div>
      </div>
      {rows.map((row) => (
        <Card key={row.id} className="p-3 space-y-2">
          <div className="text-[13px]">
            {row.question}
            {row.required ? <span className="text-bad ml-1">*</span> : null}
          </div>
          <Textarea
            value={row.answer || ""}
            onChange={(e) => {
              const v = e.target.value;
              if (q.data) qc.setQueryData(questionKey, rows.map((r) => (r.id === row.id ? { ...r, answer: v } : r)));
            }}
            onBlur={async (e) => {
              await patch(`/api/v1/positions/${id}/questions/${row.id}`, { answer: e.target.value || null });
            }}
            className="min-h-[64px]"
          />
          <div className="flex gap-2">
            <Btn
              size="xs"
              onClick={async () => {
                await patch(`/api/v1/positions/${id}/questions/${row.id}`, { status: "answered" });
                void qc.invalidateQueries({ queryKey: ["position", id, "questions"] });
              }}
            >
              Mark answered
            </Btn>
            <Btn
              size="xs"
              variant="ghost"
              onClick={async () => {
                await patch(`/api/v1/positions/${id}/questions/${row.id}`, { status: "skipped" });
                void qc.invalidateQueries({ queryKey: ["position", id, "questions"] });
              }}
            >
              Skip
            </Btn>
            <span className="font-mono text-[10px] text-faint self-center">{questionStatusLabel(row.status)}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}


function ContactsPanel({ positionId }: { positionId: string }) {
  const qc = useQueryClient();
  const q = useApi<Person[]>(["people", positionId], `/api/v1/positions/${positionId}/people`);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await post(`/api/v1/positions/${positionId}/people`, { name: name.trim(), title: title.trim() || null, linkedinUrl: linkedinUrl.trim() || null, email: email.trim() || null, notes: notes.trim() || null });
      setName("");
      setTitle("");
      setLinkedinUrl("");
      setEmail("");
      setNotes("");
      void qc.invalidateQueries({ queryKey: ["people", positionId] });
      toast.success("Contact saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await del(`/api/v1/positions/${positionId}/people/${id}`);
    void qc.invalidateQueries({ queryKey: ["people", positionId] });
  }

  const rows = q.data || [];
  return (
    <Panel title="Contacts" meta={rows.length ? String(rows.length) : undefined} flush>
      {rows.length ? (
        <div className="divide-y divide-border/60">
          {rows.map((p) => (
            <div key={p.id} className="px-3 py-2 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium truncate">{p.name}</div>
                <div className="text-[11px] text-muted truncate">
                  {[p.title, p.email].filter(Boolean).join(" · ") || "—"}
                </div>
                {p.linkedinUrl ? (
                  <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="text-[11px] text-accent hover:underline truncate block">
                    LinkedIn
                  </a>
                ) : null}
                {p.notes ? <div className="text-[11px] text-faint mt-0.5">{p.notes}</div> : null}
              </div>
              <IconBtn label="Delete contact" onClick={() => remove(p.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </IconBtn>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2 text-[12px] text-faint">No contacts yet.</div>
      )}
      <form
        className="p-3 border-t border-border space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hiring manager" />
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="LinkedIn" value={linkedinUrl} onChange={(e) => setLinkedinUrl(e.target.value)} />
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="flex justify-end">
          <Btn variant="primary" type="submit" disabled={busy || !name.trim()}>
            Add
          </Btn>
        </div>
      </form>
    </Panel>
  );
}

function InterviewsPanel({ positionId, noKey }: { positionId: string; noKey: boolean }) {
  const qc = useQueryClient();
  const q = useApi<Interview[]>(["interviews", positionId], `/api/v1/positions/${positionId}/interviews`);
  const [stage, setStage] = useState<string>("screen");
  const [title, setTitle] = useState("");
  const [interviewerName, setInterviewerName] = useState("");
  const [interviewerRole, setInterviewerRole] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [outcome, setOutcome] = useState("");
  const [notes, setNotes] = useState("");
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  function refresh() {
    void qc.invalidateQueries({ queryKey: ["interviews", positionId] });
    void qc.invalidateQueries({ queryKey: ["interview", positionId] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["position", positionId] });
  }

  async function add() {
    setBusy(true);
    try {
      await post(`/api/v1/positions/${positionId}/interviews`, {
        stage,
        title: title.trim() || null,
        interviewerName: interviewerName.trim() || null,
        interviewerRole: interviewerRole.trim() || null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
        outcome: outcome || null,
        notes: notes.trim() || null,
        notesMarkdown: notes.trim() || null,
        transcriptMarkdown: transcript.trim() || null,
        transcriptSource: transcript.trim() ? "paste" : null,
        status: occurredAt || transcript.trim() ? "completed" : "pending",
      });
      setStage("screen");
      setTitle("");
      setInterviewerName("");
      setInterviewerRole("");
      setScheduledAt("");
      setOccurredAt("");
      setOutcome("");
      setNotes("");
      setTranscript("");
      refresh();
      toast.success(transcript.trim() ? (noKey ? "Interview logged. The brief waits for a model key." : "Interview logged — AI brief queued") : "Interview logged");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    await patch(`/api/v1/positions/${positionId}/interviews/${id}`, { status });
    refresh();
  }

  async function remove(id: string) {
    await del(`/api/v1/positions/${positionId}/interviews/${id}`);
    refresh();
  }

  const rows = q.data || [];
  return (
    <Panel
      title="Interviews"
      meta={rows.length ? String(rows.length) : undefined}
      actions={
        <Link to="/interviews" className="text-[11.5px] text-muted hover:text-fg">
          All rounds
        </Link>
      }
      flush
    >
      {rows.length ? (
        <div className="divide-y divide-border/60">
          {rows.map((i) => {
            const open = openId === i.id;
            const when = i.occurredAt || i.scheduledAt;
            return (
              <div key={i.id} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(open ? null : i.id)}>
                    <div className="text-[12.5px] font-medium truncate">
                      {i.title || i.stage.replace(/_/g, " ")}
                      {i.outcome ? <span className="text-muted font-normal"> · {i.outcome}</span> : null}
                    </div>
                    <div className="text-[11px] text-muted">
                      {i.interviewerName ? `${i.interviewerName}${i.interviewerRole ? ` · ${i.interviewerRole}` : ""} · ` : ""}
                      {when ? dateTime(when) : "unscheduled"}
                      {(i.transcriptChars ?? 0) > 0 ? ` · transcript ${i.transcriptChars!.toLocaleString()}c` : ""}
                      {i.aiBriefedAt ? " · AI brief" : ""}
                    </div>
                    {i.notes && !open ? <div className="text-[11px] text-faint mt-0.5 line-clamp-2">{i.notes}</div> : null}
                  </button>
                  <select
                    aria-label="Interview status"
                    value={i.status}
                    onChange={(e) => void setStatus(i.id, e.target.value)}
                    className="h-7 rounded-md border border-border bg-bg px-1.5 text-[11px] text-muted"
                  >
                    {INTERVIEW_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <IconBtn label="Delete interview" onClick={() => remove(i.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconBtn>
                </div>
                {open ? <InterviewRoundBody positionId={positionId} row={i} onBrief={refresh} /> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-3 py-2 text-[12px] text-faint">No interviews logged.</div>
      )}
      <form
        className="p-3 border-t border-border space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Select label="Stage" value={stage} onChange={(e) => setStage(e.target.value)}>
          {INTERVIEW_STAGES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="TA screen — Ryan Zubal" />
        <Input label="Interviewer" value={interviewerName} onChange={(e) => setInterviewerName(e.target.value)} />
        <Input label="Interviewer role" value={interviewerRole} onChange={(e) => setInterviewerRole(e.target.value)} placeholder="Talent Sourcing Manager" />
        <Input label="Scheduled" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        <Input label="Occurred" type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
        <Select label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">unset</option>
          {INTERVIEW_OUTCOMES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <Textarea label="Transcript" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={noKey ? "Paste a transcript. The brief waits until a model key is set." : "Paste merged transcript — queues an AI brief vs the JD"} className="min-h-[72px]" />
        <div className="flex justify-end">
          <Btn variant="primary" type="submit" disabled={busy}>
            Add
          </Btn>
        </div>
      </form>
    </Panel>
  );
}
