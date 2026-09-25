import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DecisionRecord, DecisionRecipe, JevConfig } from "@job-scout/shared";
import { patch, post, useApi } from "@/lib/api";
import { Btn, Input, Panel, Select } from "@/ui/kit";

type Status = { config: JevConfig; configured: boolean; today: { calls: number; errors: number; cost: number; tokens: number } };
const labels: Record<DecisionRecipe, string> = { triage: "Job fit", ranking: "Review priority", evaluation_check: "Evaluation claims", materials_check: "Résumé and cover claims", connection_test: "Connection test" };
const percent = (value: number | null) => value == null ? "—" : `${Math.round(value * 100)}%`;

export function JevSettings() {
  const status = useApi<Status>(["jev", "status"], "/api/v1/settings/jev", { refetchInterval: 30_000 });
  const runs = useApi<DecisionRecord[]>(["jev", "runs"], "/api/v1/settings/jev/runs", { refetchInterval: 30_000 });
  const [draft, setDraft] = useState<JevConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  useEffect(() => { if (status.data && !draft) setDraft(status.data.config); }, [status.data, draft]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["jev"] });
  async function save() {
    setBusy(true);
    try { await patch("/api/v1/settings", { jev: draft }); await refresh(); toast.success("Jev settings saved"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not save Jev settings"); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true);
    try {
      const run = await post<DecisionRecord>("/api/v1/settings/jev/preview", { recipe: "connection_test" });
      if (run.status !== "ok") throw new Error(run.error || "Connection test failed");
      toast.success(`Jev answered in ${run.result?.latencyMs} ms`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Connection test failed"); }
    finally { setBusy(false); await refresh(); }
  }
  if (status.error) return <Panel title="Jev decisions"><p>Could not load Jev settings. <button onClick={() => { void status.refetch(); }}>Try again</button></p></Panel>;
  if (!draft || !status.data) return <Panel title="Jev decisions">Loading settings…</Panel>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(status.data.config);
  const change = <K extends keyof JevConfig>(field: K, value: JevConfig[K]) => setDraft({ ...draft, [field]: value });
  return <div className="space-y-4">
    <Panel title="Jev decisions" meta={status.data.configured ? "OpenRouter key configured" : "OpenRouter key missing"}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">Jev returns choices and scores. Use it to screen a role, order your review queue, or check a draft against its sources. Your writing models still produce evaluations and application materials.</p>
        {!status.data.configured && <p className="text-warn">Set OPENROUTER_API_KEY in the server environment, then restart the API and worker.</p>}
        <p className="text-xs text-muted">A decision sends the relevant job description and profile evidence to OpenRouter and TypeSafe. Draft checks also send the draft. Loading this page makes no model calls.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.enabled} onChange={e => change("enabled", e.target.checked)} />Enable Jev</label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Decision model" value={draft.model} onChange={e => change("model", e.target.value as JevConfig["model"])}><option value="typesafe/jev-1.13">Jev 1.13</option><option value="~typesafe/jev-latest">Latest Jev version</option></Select>
          <Select label="Fast triage" value={draft.triage} onChange={e => change("triage", e.target.value as JevConfig["triage"])}><option value="off">Off</option><option value="observe">Observe: compare with normal triage</option><option value="apply">Use clear matches; otherwise run normal triage</option></Select>
          <Select label="Draft checks" value={draft.verification} onChange={e => change("verification", e.target.value as JevConfig["verification"])}><option value="off">Off</option><option value="observe">Observe: record the check</option><option value="apply">Hold follow-up automation when a check fails</option></Select>
          <Input label="Daily request limit (UTC)" type="number" min={1} max={10000} value={draft.dailyCalls} onChange={e => change("dailyCalls", Number(e.target.value))} />
          <Input label="Minimum confidence" hint="How concentrated the route choice is; not a measured accuracy rate." type="number" min={0} max={1} step={0.01} value={draft.minConfidence} onChange={e => change("minConfidence", Number(e.target.value))} />
          <Input label="Minimum answer probability" hint="Required for the route, yes/no checks and strong-fit score levels." type="number" min={0.5} max={1} step={0.01} value={draft.minProbability} onChange={e => change("minProbability", Number(e.target.value))} />
          <Input label="Request timeout (ms)" type="number" min={500} max={30000} step={500} value={draft.timeoutMs} onChange={e => change("timeoutMs", Number(e.target.value))} />
          <Input label="Maximum input characters" hint="Includes profile evidence, the job and any draft. Inputs above this limit are skipped without truncation." type="number" min={1000} max={80000} step={1000} value={draft.maxStateChars} onChange={e => change("maxStateChars", Number(e.target.value))} />
          <Input label="Reuse identical decisions (minutes)" type="number" min={0} max={1440} value={draft.cacheMinutes} onChange={e => change("cacheMinutes", Number(e.target.value))} />
        </div>
        <p className="text-xs text-muted">Large or uncertain inputs use normal triage. A failed draft check keeps the draft for review. It cannot approve materials or submit an application.</p>
        <label className="flex items-center gap-2"><input type="checkbox" checked={draft.ranking} onChange={e => change("ranking", e.target.checked)} />Enable review ranking</label>
        <div className="grid grid-cols-3 gap-3">{(["role", "skills", "seniority"] as const).map(k => <Input key={k} label={`${k[0].toUpperCase()}${k.slice(1)} weight`} type="number" min={0} max={10} step={1} value={draft.weights[k]} onChange={e => change("weights", { ...draft.weights, [k]: Number(e.target.value) })} />)}</div>
        <div className="flex flex-wrap items-center gap-3"><Btn onClick={() => { void save(); }} disabled={!dirty || busy}>Save Jev settings</Btn><Btn variant="outline" onClick={() => { void test(); }} disabled={busy || dirty || !draft.enabled || !status.data.configured}>Test Jev connection</Btn>{dirty && <span className="text-xs text-muted">Save before testing.</span>}</div>
        <p className="text-xs text-muted">Today: {status.data.today.calls}/{status.data.config.dailyCalls} requests · {status.data.today.tokens.toLocaleString()} input tokens · ${status.data.today.cost.toFixed(6)} reported cost · {status.data.today.errors} errors. Jev has its own request limit.</p>
      </div>
    </Panel>
    <JevQueue />
    <Panel title="Recent decisions" meta="Agree or disagree to keep track of mistakes">
      <details><summary className="cursor-pointer text-sm">Show {runs.data?.length ?? 0} recent decisions</summary><div className="space-y-3 mt-3">{runs.data?.length ? runs.data.map(run => <DecisionCard key={run.id} run={run} />) : <p className="text-sm text-muted">No decisions yet. Test the connection or open a position and run a check.</p>}</div></details>
    </Panel>
  </div>;
}

export function DecisionCard({ run }: { run: DecisionRecord }) {
  const qc = useQueryClient();
  const [judgment, setJudgment] = useState(run.feedback);
  useEffect(() => setJudgment(run.feedback), [run.feedback, run.id]);
  async function feedback(value: "agree" | "disagree") {
    try { const updated = await patch<DecisionRecord>(`/api/v1/settings/jev/runs/${run.id}`, { feedback: judgment === value ? null : value }); setJudgment(updated.feedback); await qc.invalidateQueries({ queryKey: ["jev"] }); }
    catch { toast.error("Could not save feedback"); }
  }
  return <article className="rounded border border-border p-3 space-y-2 text-xs">
    <div className="flex flex-wrap gap-2"><strong>{labels[run.recipe]}</strong><span>{run.mode}</span><span>{run.cached ? "Reused result" : new Date(run.createdAt).toLocaleString()}</span></div>
    {run.error && <p className="text-warn">{run.error}</p>}
    {run.status === "running" && <p>Request started; no result recorded yet.</p>}
    {run.summary && <p>{run.summary.route} · score {run.summary.score?.toFixed(1) ?? "—"}/5 · confidence {percent(run.summary.confidence)} · supporting probability {percent(run.summary.probability)} · {run.summary.accepted ? "Meets thresholds" : "Needs review"}</p>}
    {run.result && <>
      <p className="text-muted break-all">{run.result.model} · {run.result.latencyMs} ms · {run.result.inputTokens} input tokens · {run.result.cost == null ? "Cost not reported" : `$${run.result.cost.toFixed(6)}`}</p>
      <details><summary className="cursor-pointer">Answers and probabilities</summary><div className="mt-2 grid gap-3 sm:grid-cols-2">{Object.entries(run.result.answers).map(([name, answer]) => <div key={name}><strong>{name}</strong>{answer.type !== "noul" && <span className="text-muted"> · confidence {percent(answer.confidence)}</span>}{answer.type === "noul" ? <Probability label="Yes" value={answer.noul} /> : Object.entries(answer.probabilities).map(([choice, p]) => <Probability key={choice} label={answer.type === "score" ? answer.legend?.[choice] || choice : choice} value={p} />)}</div>)}</div></details>
      <div className="flex gap-2"><Btn size="xs" variant={judgment === "agree" ? "primary" : "outline"} onClick={() => { void feedback("agree"); }}>Agree</Btn><Btn size="xs" variant={judgment === "disagree" ? "primary" : "outline"} onClick={() => { void feedback("disagree"); }}>Disagree</Btn></div>
    </>}
  </article>;
}

function Probability({ label, value }: { label: string; value: number }) {
  return <div className="mt-1"><div className="flex justify-between gap-2"><span>{label}</span><span>{percent(value)}</span></div><div className="h-1 bg-border rounded"><div className="h-1 bg-accent rounded" style={{ width: `${value * 100}%` }} /></div></div>;
}

export function JevPosition({ positionId }: { positionId: string }) {
  const status = useApi<Status>(["jev", "status"], "/api/v1/settings/jev");
  const runs = useApi<DecisionRecord[]>(["jev", "position", positionId], `/api/v1/settings/jev/runs?positionId=${encodeURIComponent(positionId)}`);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState(false);
  const qc = useQueryClient();
  if (!status.data?.config.enabled) return null;
  async function run(recipe: DecisionRecipe) {
    setBusy(true);
    try { const r = await post<DecisionRecord>("/api/v1/settings/jev/preview", { recipe, positionId, fresh }); if (r.error) toast.error(r.error); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not run decision"); }
    finally { setBusy(false); await qc.invalidateQueries({ queryKey: ["jev"] }); }
  }
  return <Panel title="Jev checks" meta="Preview only; these buttons leave the position unchanged">
    <div className="space-y-3"><div className="flex flex-wrap gap-2">{(["triage", "ranking", "evaluation_check", "materials_check"] as const).map(recipe => <Btn key={recipe} variant="outline" size="xs" disabled={busy} onClick={() => { void run(recipe); }}>{labels[recipe]}</Btn>)}</div>
      <label className="flex gap-2 text-xs"><input type="checkbox" checked={fresh} onChange={e => setFresh(e.target.checked)} />Make a new request instead of reusing a matching result</label>
      {busy && <p className="text-xs" role="status">Waiting for Jev…</p>}
      {runs.data?.slice(0, 4).map(r => <DecisionCard key={r.id} run={r} />)}
    </div>
  </Panel>;
}

type Ranking = { total: number; rows: { positionId: string; slug: string; title: string; triageScore: number | null; run: DecisionRecord | null; error: string | null }[] };
export function JevQueue({ enabledOnly = false }: { enabledOnly?: boolean }) {
  const status = useApi<Status>(["jev", "status"], "/api/v1/settings/jev");
  const [ranking, setRanking] = useState<Ranking | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  async function rank() {
    setBusy(true);
    try { setRanking(await post<Ranking>("/api/v1/settings/jev/rank", { limit: 10 })); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not rank positions"); }
    finally { setBusy(false); await qc.invalidateQueries({ queryKey: ["jev"] }); }
  }
  if (enabledOnly && (!status.data?.config.enabled || !status.data.config.ranking)) return null;
  return <Panel title="Review priority" actions={<Btn size="xs" variant="outline" disabled={busy || !status.data?.config.enabled || !status.data.config.ranking} onClick={() => { void rank(); }}>{busy ? "Ranking…" : "Rank next 10 positions"}</Btn>}>
    <p className="text-xs text-muted">Compare the first 10 actionable roles in your triage queue. Jev scores role, skills and seniority separately; clear matches come first, followed by uncertain roles and mismatches. Your weights sort each group. Existing scores and statuses stay unchanged.</p>
    {ranking && <div className="mt-3 space-y-3"><p className="text-xs">{ranking.rows.length} of {ranking.total} positions in the review queue</p>{ranking.rows.map(r => <div key={r.positionId}><Link to="/positions/$id" params={{ id: r.slug }} className="text-sm text-accent">{r.title}</Link><p className="text-xs text-muted">Current triage: {r.triageScore ?? "Unscored"}</p>{r.run ? <DecisionCard run={r.run} /> : <p className="text-xs text-warn">{r.error}</p>}</div>)}</div>}
  </Panel>;
}
