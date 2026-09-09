/**
 * One-off v1 -> v2 importer.
 *
 *   SOURCE_DATABASE_URL=postgres://.../job_scout DATABASE_URL=postgres://.../job_scout_v2 \
 *     pnpm db:import-v1 [--commit] [--triage]
 *
 * Dry-run by default: prints what would be carried / archived. `--commit` writes.
 * `--triage` enqueues a triage job for every carried, untriaged position.
 *
 * Rules (from the plan):
 * - companies, board_sources, profiles, api_tokens, people, interviews,
 *   outreach_events, watches(enabled) are copied.
 * - positions with status in materials/applied/screen/interview/offer/rejected/skip
 *   + geo_class in brazil_friendly/worldwideish are carried (status mapped).
 *   Everything else is imported as `archived` with a reason.
 * - jd_revisions: first_seen + material non-closed revisions + one `closed`.
 * - application_materials only for carried positions.
 * - discovery_feed / board_deltas: last 30 days. jobs, snapshots, harness, intakes skipped.
 */
import pg from "pg";
import { sql } from "drizzle-orm";
import { getDb, closeDb } from "@job-scout/db";
import { bootstrap, enqueueJob } from "@job-scout/core";
import { HOT_STATUSES } from "@job-scout/shared";

const COMMIT = process.argv.includes("--commit");
const TRIAGE = process.argv.includes("--triage");
const SRC = process.env.SOURCE_DATABASE_URL;
if (!SRC) throw new Error("SOURCE_DATABASE_URL required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL (target v2) required");
if (process.env.DATABASE_URL.replace(/\?.*$/, "") === SRC.replace(/\?.*$/, "")) throw new Error("source and target are the same database");

const src = new pg.Pool({ connectionString: SRC.replace(/([?&])sslmode=[^&]*/gi, "$1").replace(/[?&]$/, ""), ssl: { rejectUnauthorized: false }, max: 2, idleTimeoutMillis: 0 });

const STATUS_MAP: Record<string, string> = {
  idea: "triaged",
  research: "triaged",
  materials: "materials",
  applied: "applied",
  screen: "screen",
  interview: "interview",
  offer: "offer",
  rejected: "rejected",
  ghost: "rejected",
  withdrawn: "skip",
  skip: "skip",
  archive: "archived",
};
const CARRY_STATUSES = new Set([...HOT_STATUSES, "rejected", "skip"]);
const CARRY_GEO = new Set(["brazil_friendly", "worldwideish"]);

type Row = Record<string, unknown>;
const q = async <T = Row>(text: string, params: unknown[] = []) => (await src.query(text, params)).rows as T[];

function jsonb(v: unknown) {
  return sql`${JSON.stringify(v ?? {})}::jsonb`;
}

async function main() {
  console.log(`[import-v1] ${COMMIT ? "COMMIT" : "DRY-RUN"} source=${SRC!.replace(/:[^:@/]+@/, ":***@")}`);
  await bootstrap({ seedBoards: false });
  const db = await getDb();

  const existing = (await db.execute(sql`select count(*)::int as c from positions`)) as unknown as { rows: { c: number }[] };
  if ((existing.rows?.[0]?.c ?? 0) > 0 && COMMIT && !process.argv.includes("--force")) {
    throw new Error("target already has positions; pass --force to import anyway");
  }

  // ---- positions decision ---------------------------------------------------
  const positions = await q(`select p.*, c.slug as company_slug from positions p join companies c on c.id = p.company_id`);
  const carry: Row[] = [];
  const archive: Array<{ row: Row; reason: string }> = [];
  for (const p of positions) {
    const status = String(p.status);
    const geo = String(p.geo_class || "unknown");
    if (CARRY_STATUSES.has(status as never)) carry.push(p);
    else if (status === "archive") archive.push({ row: p, reason: `v1 archive: ${String(p.notes || "").slice(0, 80) || p.fit_tier || geo}` });
    else if (CARRY_GEO.has(geo) && p.listing_status !== "closed") carry.push(p);
    else archive.push({ row: p, reason: `v1-bulk-import: ${geo}/${String(p.fit_tier || "untiered")}${p.listing_status === "closed" ? "/closed" : ""}` });
  }
  const carryIds = new Set(carry.map((p) => String(p.id)));
  const allIds = positions.map((p) => String(p.id));

  const revAll = await q<{ position_id: string; revision: number; change_kind: string; material: boolean }>(
    `select position_id, revision, change_kind, material from jd_revisions order by position_id, revision`,
  );
  const keepRevs = new Set<string>();
  {
    const seenClosed = new Set<string>();
    for (const r of revAll) {
      const key = `${r.position_id}:${r.revision}`;
      if (r.change_kind === "first_seen" || r.revision === 1) keepRevs.add(key);
      else if (r.change_kind === "closed") {
        if (!seenClosed.has(r.position_id)) {
          seenClosed.add(r.position_id);
          keepRevs.add(key);
        }
      } else if (r.material) keepRevs.add(key);
    }
  }

  const companies = await q(`select * from companies`);
  const boards = await q(`select * from board_sources`);
  const profiles = await q(`select * from profiles`);
  const tokens = await q(`select * from api_tokens where revoked_at is null`);
  const people = await q(`select * from people`);
  const interviews = await q(`select * from interviews`);
  const outreach = await q(`select * from outreach_events`);
  const watches = await q(`select * from watches where enabled`);
  const materials = await q(`select * from application_materials where position_id = any($1)`, [[...carryIds]]);
  const questions = await q(`select * from application_questions where position_id = any($1)`, [[...carryIds]]);
  const timeline = await q(`select * from timeline_events where position_id = any($1) and kind <> 'system'`, [[...carryIds]]);
  const discovery = await q(`select * from discovery_feed where observed_at > now() - interval '30 days'`);
  const deltas = await q(`select * from board_deltas where observed_at > now() - interval '30 days'`);

  console.table({
    companies: companies.length,
    board_sources: boards.length,
    positions_total: positions.length,
    positions_carry: carry.length,
    positions_archive: archive.length,
    jd_revisions_total: revAll.length,
    jd_revisions_keep: keepRevs.size,
    materials: materials.length,
    questions: questions.length,
    timeline: timeline.length,
    people: people.length,
    interviews: interviews.length,
    outreach: outreach.length,
    watches: watches.length,
    discovery_30d: discovery.length,
    deltas_30d: deltas.length,
    api_tokens: tokens.length,
  });
  const byStatus: Record<string, number> = {};
  for (const p of carry) byStatus[`${p.status}->${STATUS_MAP[String(p.status)] || "triaged"}`] = (byStatus[`${p.status}->${STATUS_MAP[String(p.status)] || "triaged"}`] || 0) + 1;
  console.log("[import-v1] carried by status:", byStatus);
  const reasons: Record<string, number> = {};
  for (const a of archive) reasons[a.reason.split("/")[0]!] = (reasons[a.reason.split("/")[0]!] || 0) + 1;
  console.log("[import-v1] archive reasons:", reasons);

  if (!COMMIT) {
    console.log("[import-v1] dry-run complete; re-run with --commit to write");
    await src.end();
    await closeDb();
    return;
  }

  // ---- write ------------------------------------------------------------------
  await db.execute(sql`begin`);
  try {
    for (const c of companies) {
      await db.execute(sql`insert into companies (id, slug, name, website, careers_url, industry_tags, overview, metadata, created_at, updated_at)
        values (${c.id}, ${c.slug}, ${c.name}, ${c.website}, ${c.careers_url}, ${jsonb(c.industry_tags ?? [])}, ${c.overview}, ${jsonb(stripCompanyMeta(c.metadata))}, ${c.created_at}, ${c.updated_at})
        on conflict (id) do nothing`);
    }
    for (const b of boards) {
      await db.execute(sql`insert into board_sources (id, company, provider, token, careers_url, enabled, source_kind, tags, notes, capability, last_scanned_at, metadata, created_at)
        values (${b.id}, ${b.company}, ${b.provider}, ${b.token}, ${b.careers_url}, ${b.enabled}, ${b.source_kind}, ${jsonb(b.tags ?? [])}, ${b.notes}, ${b.capability}, ${null}, ${jsonb(b.metadata)}, ${b.created_at})
        on conflict (provider, token) do nothing`);
    }
    // profile: v2 bootstrap already created a default row; replace it with v1's.
    if (profiles[0]) {
      const p = profiles[0];
      await db.execute(sql`delete from profiles`);
      await db.execute(sql`insert into profiles (id, display_name, email, location, linkedin_url, github_url, last_title, last_company, cash_floor_usd, north_star, target_roles, resume_surfaces, identity_markdown, master_resume_markdown, master_cover_markdown, scout_brief, metadata, created_at, updated_at)
        values (${p.id}, ${p.display_name}, ${p.email}, ${p.location}, ${p.linkedin_url}, ${p.github_url}, ${p.last_title}, ${p.last_company}, ${p.cash_floor_usd}, ${p.north_star}, ${jsonb(p.target_roles ?? [])}, ${jsonb(p.resume_surfaces ?? {})}, ${p.identity_markdown}, ${p.master_resume_markdown}, ${p.master_cover_markdown}, ${null}, ${jsonb({ v1ScoutParams: p.scout_params })}, ${p.created_at}, ${p.updated_at})`);
    }
    for (const t of tokens) {
      await db.execute(sql`insert into api_tokens (id, name, token_hash, token_prefix, scopes, last_used_at, revoked_at, created_at)
        values (${t.id}, ${t.name}, ${t.token_hash}, ${t.token_prefix}, ${jsonb(t.scopes ?? ["agent"])}, ${t.last_used_at}, ${null}, ${t.created_at}) on conflict (id) do nothing`);
    }

    const decisions = [...carry.map((row) => ({ row, archived: false, reason: null as string | null })), ...archive.map((a) => ({ row: a.row, archived: true, reason: a.reason }))];
    for (const { row: p, archived, reason } of decisions) {
      const status = archived ? "archived" : STATUS_MAP[String(p.status)] || "triaged";
      const meta = (p.metadata || {}) as Record<string, unknown>;
      const nextMeta: Record<string, unknown> = { ats: meta.ats, careerOps: meta.careerOpsStamp, v1: { status: p.status, fitScore: p.fit_score, fitTier: p.fit_tier, llmFitScore: p.llm_fit_score, llmFitSummary: p.llm_fit_summary, matchLabel: p.match_label, lane: p.lane } };
      await db.execute(sql`insert into positions (id, company_id, slug, title, status, priority, applied_at, resume_surface, primary_url, ats_provider, ats_job_id, ats_board_token, external_identity, craft_family, geo_class, remote_class, geo_notes, archive_reason,
          salary_min, salary_max, salary_currency, salary_period, salary_raw, equity_notes, employment_type, source, watch_enabled, content_hash, listing_status, first_seen_at, last_checked_at, last_changed_at, closed_at, next_action, notes, metadata, created_at, updated_at)
        values (${p.id}, ${p.company_id}, ${p.slug}, ${p.title}, ${status}, ${p.priority}, ${p.applied_at}, ${p.resume_surface}, ${p.primary_url}, ${p.ats_provider}, ${p.ats_job_id}, ${p.ats_board_token}, ${p.external_identity}, ${p.craft_family}, ${p.geo_class}, ${p.remote_class}, ${p.geo_notes}, ${reason},
          ${p.salary_min}, ${p.salary_max}, ${p.salary_currency}, ${p.salary_period}, ${p.salary_raw}, ${p.equity_notes}, ${p.employment_type}, ${p.source}, ${archived ? false : Boolean(p.watch_enabled)}, ${p.content_hash}, ${p.listing_status}, ${p.first_seen_at}, ${p.last_checked_at}, ${p.last_changed_at}, ${p.closed_at}, ${p.next_action}, ${p.notes}, ${jsonb(nextMeta)}, ${p.created_at}, ${p.updated_at})
        on conflict (id) do nothing`);
      // v1 jd_review markdown becomes an evaluation record (kind jd_review) so nothing is lost
      if (!archived && p.jd_review_markdown) {
        await db.execute(sql`insert into evaluations (id, position_id, company_id, kind, model, markdown, json, created_at)
          values (${"ev_v1_" + String(p.id).slice(-8)}, ${p.id}, ${p.company_id}, ${"jd_review"}, ${String(p.jd_review_agent || "v1")}, ${p.jd_review_markdown}, ${jsonb({ score: p.jd_review_score, matches: p.jd_review_matches, gaps: p.jd_review_gaps, summary: p.jd_review_summary })}, ${p.jd_review_at || p.updated_at})
          on conflict (id) do nothing`);
      }
    }

    // revisions in batches
    const revRows = await q(`select * from jd_revisions where position_id = any($1) order by position_id, revision`, [allIds]);
    let revWritten = 0;
    for (const r of revRows) {
      if (!keepRevs.has(`${r.position_id}:${r.revision}`)) continue;
      await db.execute(sql`insert into jd_revisions (id, position_id, revision, observed_at, content_hash, change_kind, material, title, location_raw, description_text, salary_min, salary_max, salary_currency, salary_period, salary_raw, tech_tags, remote_class, geo_class, diff_summary, field_diffs, source, created_at)
        values (${r.id}, ${r.position_id}, ${r.revision}, ${r.observed_at}, ${r.content_hash}, ${r.change_kind}, ${r.material}, ${r.title}, ${r.location_raw}, ${r.description_text}, ${r.salary_min}, ${r.salary_max}, ${r.salary_currency}, ${r.salary_period}, ${r.salary_raw}, ${jsonb(r.tech_tags ?? [])}, ${r.remote_class}, ${r.geo_class}, ${r.diff_summary}, ${jsonb(r.field_diffs ?? [])}, ${r.source}, ${r.created_at})
        on conflict (id) do nothing`);
      revWritten++;
    }

    for (const m of materials) {
      await db.execute(sql`insert into application_materials (id, position_id, kind, version, is_current, status, title, body_markdown, pdf_base64, pdf_file_name, model, source, notes, metadata, created_at, updated_at)
        values (${m.id}, ${m.position_id}, ${m.kind}, ${m.version}, ${m.is_current}, ${m.status === "ready" ? "ready" : m.status === "failed" ? "failed" : "ready"}, ${m.title}, ${m.body_markdown}, ${m.pdf_base64}, ${m.pdf_file_name}, ${m.agent_name}, ${m.source}, ${m.notes}, ${jsonb(m.metadata)}, ${m.created_at}, ${m.updated_at})
        on conflict (id) do nothing`);
    }
    for (const qq of questions) {
      await db.execute(sql`insert into application_questions (id, position_id, sort_order, question, answer, status, source, metadata, created_at, updated_at)
        values (${qq.id}, ${qq.position_id}, ${qq.sort_order}, ${qq.question}, ${qq.answer}, ${qq.status === "answered" ? "answered" : qq.status === "skipped" ? "skipped" : "open"}, ${qq.source}, ${jsonb(qq.metadata)}, ${qq.created_at}, ${qq.updated_at}) on conflict (id) do nothing`);
    }
    for (const t of timeline) {
      await db.execute(sql`insert into timeline_events (id, position_id, kind, title, body, actor, metadata, occurred_at, created_at)
        values (${t.id}, ${t.position_id}, ${t.kind}, ${t.title}, ${t.body}, ${t.actor}, ${jsonb(t.metadata)}, ${t.occurred_at}, ${t.created_at}) on conflict (id) do nothing`);
    }
    for (const pp of people) {
      await db.execute(sql`insert into people (id, company_id, name, title, linkedin_url, email, notes, metadata, created_at)
        values (${pp.id}, ${pp.company_id}, ${pp.name}, ${pp.title}, ${pp.linkedin_url}, ${pp.email}, ${pp.notes}, ${jsonb(pp.metadata)}, ${pp.created_at}) on conflict (id) do nothing`);
    }
    for (const i of interviews) {
      if (!carryIds.has(String(i.position_id))) continue;
      await db.execute(sql`insert into interviews (id, position_id, stage, scheduled_at, status, notes, metadata, created_at, updated_at)
        values (${i.id}, ${i.position_id}, ${i.stage}, ${i.scheduled_at}, ${i.status}, ${i.notes}, ${jsonb(i.metadata)}, ${i.created_at}, ${i.updated_at}) on conflict (id) do nothing`);
    }
    for (const o of outreach) {
      await db.execute(sql`insert into outreach_events (id, position_id, company_id, channel, who, note, occurred_at, created_at)
        values (${o.id}, ${o.position_id}, ${o.company_id}, ${o.channel}, ${o.who}, ${o.note}, ${o.occurred_at}, ${o.created_at}) on conflict (id) do nothing`);
    }
    for (const w of watches) {
      if (w.position_id && !carryIds.has(String(w.position_id))) continue;
      await db.execute(sql`insert into watches (id, position_id, url, label, enabled, content_hash, listing_status, last_checked_at, last_changed_at, notes, metadata, created_at, updated_at)
        values (${w.id}, ${w.position_id}, ${w.url}, ${w.label}, ${true}, ${w.content_hash}, ${w.listing_status}, ${w.last_checked_at}, ${w.last_changed_at}, ${w.notes}, ${jsonb(w.metadata)}, ${w.created_at}, ${w.updated_at}) on conflict (id) do nothing`);
    }
    const seenExt = new Set<string>();
    for (const d of discovery) {
      const ext = d.external_identity ? String(d.external_identity) : null;
      if (ext && seenExt.has(ext)) continue;
      if (ext) seenExt.add(ext);
      const lane = d.match_label === "match" ? "passed" : "filtered";
      await db.execute(sql`insert into discovery_feed (id, external_identity, company, title, url, location_raw, craft_family, geo_class, lane, gate_reason, provider, observed_at, metadata, created_at)
        values (${d.id}, ${ext}, ${d.company}, ${d.title}, ${d.url}, ${d.location_raw}, ${d.craft_family}, ${d.geo_class}, ${lane}, ${lane === "filtered" ? `v1:${String(d.match_label)}` : null}, ${d.provider}, ${d.observed_at}, ${jsonb({ v1Lane: d.lane, v1Score: d.score_hint })}, ${d.created_at}) on conflict do nothing`);
    }
    for (const d of deltas) {
      await db.execute(sql`insert into board_deltas (id, board_source_id, event, external_identity, title, company, url, location_raw, craft_family, geo_class, observed_at, metadata, created_at)
        values (${d.id}, ${d.board_source_id}, ${d.event}, ${d.external_identity}, ${d.title}, ${d.company}, ${d.url}, ${d.location_raw}, ${d.craft_family}, ${d.geo_class}, ${d.observed_at}, ${jsonb(d.metadata)}, ${d.created_at}) on conflict (id) do nothing`);
    }
    await db.execute(sql`commit`);
    console.log(`[import-v1] committed: positions=${decisions.length} revisions=${revWritten} materials=${materials.length}`);
  } catch (e) {
    await db.execute(sql`rollback`);
    throw e;
  }

  if (TRIAGE) {
    let n = 0;
    for (const p of carry) {
      const r = await enqueueJob("triage", { positionId: p.id, force: true }, { dedupeKey: `triage:${p.id}`, priority: 70 });
      if (!r.deduped) n++;
    }
    console.log(`[import-v1] enqueued triage for ${n} positions`);
  }
  await src.end();
  await closeDb();
}

/** Drop the bulky v1 research blobs from company metadata; keep small keys. */
function stripCompanyMeta(meta: unknown): Record<string, unknown> {
  const m = (meta || {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    const size = JSON.stringify(v ?? null).length;
    if (size <= 4000) out[k] = v;
    else out[`${k}Omitted`] = `v1 blob ${size} bytes dropped at import`;
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
