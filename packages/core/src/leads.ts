import { and, desc, eq, getTableColumns, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, id, interviews, leads, outreachEvents } from "@job-scout/db";
import {
  ATS_KEYWORD_CATALOG,
  LEAD_BUCKETS,
  LEAD_CALL_SOON_HOURS,
  LEAD_STALL_DAYS,
  LEAD_TERMINAL_STATUSES,
  leadDedupeKey,
  leadTriage,
  parseLeadDirection,
  parseLeadStatus,
  redactContactText,
  termInText,
  type LeadBucket,
  type LeadDirection,
  type LeadStatus,
  type LeadTriage,
} from "@job-scout/shared";
import { addEvent } from "./timeline.js";
import { getProfile } from "./profile.js";
import { addLeadInterview, listLeadInterviews, patchLeadInterview, type InterviewInput } from "./interviews.js";
import { decodeCursor, encodeCursor, filterFingerprint } from "./list-cursor.js";

/**
 * Recruiter leads: recruiter × pitched role, usually with no job URL, pay band
 * or named client yet. Tracking only: nothing in this module sends a message,
 * enqueues a model job or emits a notification.
 */
export type Lead = typeof leads.$inferSelect;

export type LeadInput = {
  status?: string;
  source?: string | null;
  recruiterName?: string | null;
  recruiterCompany?: string | null;
  recruiterProfileUrl?: string | null;
  recruiterEmail?: string | null;
  recruiterPhone?: string | null;
  pitchedRole?: string | null;
  clientHint?: string | null;
  statedPay?: string | null;
  statedGeo?: string | null;
  statedContract?: string | null;
  openUnknowns?: string[] | null;
  threadUrls?: string[] | null;
  threadUrl?: string | null;
  notes?: string | null;
  nextAction?: string | null;
  closedReason?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type LeadMessageInput = {
  direction: string;
  body?: string | null;
  channel?: string | null;
  who?: string | null;
  occurredAt?: string | Date | null;
  threadUrl?: string | null;
};

const TEXT_FIELDS = [
  "source", "recruiterName", "recruiterCompany", "recruiterProfileUrl", "recruiterEmail", "recruiterPhone",
  "pitchedRole", "clientHint", "statedPay", "statedGeo", "statedContract", "notes", "nextAction", "closedReason",
] as const;

const trimOrNull = (v: string | null | undefined) => {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
};

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.map((x) => trimOrNull(x)).filter((x): x is string => !!x))];

function parseWhen(v: string | Date | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("occurredAt must be ISO");
  return d;
}

/** Stack terms the profile claims: catalog terms present in the identity, master resume and target roles. */
async function profileForTriage() {
  const p = await getProfile();
  const text = [p.identityMarkdown, p.masterResumeMarkdown, (p.targetRoles || []).join(" "), p.northStar].filter(Boolean).join("\n");
  const stackText = ATS_KEYWORD_CATALOG.filter((t) => termInText(t, text)).join(" ");
  return { cashFloorUsd: p.cashFloorUsd, stackText };
}

export function triageOfLead(l: Pick<Lead, "pitchedRole" | "clientHint" | "statedPay" | "statedGeo" | "statedContract" | "notes" | "openUnknowns">, profile: { cashFloorUsd?: number | null; stackText?: string | null }): LeadTriage {
  return leadTriage(l, profile);
}

async function retriage(leadId: string) {
  const db = await getDb();
  const row = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)).at(0);
  if (!row) return null;
  const triage = triageOfLead(row, await profileForTriage());
  await db.update(leads).set({ triageJson: triage as unknown as Record<string, unknown> }).where(eq(leads.id, leadId));
  return { ...row, triageJson: triage as unknown as Record<string, unknown> };
}

/**
 * SQL bucket for an active lead; null for promoted/closed. Thresholds live in
 * @job-scout/shared. The subquery names "leads"."id" explicitly: drizzle leaves
 * columns unqualified in a single-table select, and a bare "id" would bind to
 * the interview.
 */
const BUCKET = sql<LeadBucket | null>`case
  when ${leads.status} in ('promoted', 'closed') then null
  when exists (select 1 from interviews li where li.lead_id = "leads"."id" and li.status = 'pending'
    and li.scheduled_at >= now() - interval '1 day' and li.scheduled_at <= now() + make_interval(hours => ${LEAD_CALL_SOON_HOURS})) then 'call_soon'
  when ${leads.lastInboundAt} is not null and (${leads.lastOutboundAt} is null or ${leads.lastInboundAt} > ${leads.lastOutboundAt}) then 'needs_reply'
  when ${leads.lastOutboundAt} is null and ${leads.status} in ('new', 'vetted') then 'needs_reply'
  when ${leads.lastOutboundAt} is not null and ${leads.lastOutboundAt} > now() - make_interval(days => ${LEAD_STALL_DAYS}) then 'waiting'
  else 'stalled'
end`;

const LEAN = {
  id: leads.id,
  status: leads.status,
  bucket: BUCKET,
  source: leads.source,
  recruiterName: leads.recruiterName,
  recruiterCompany: leads.recruiterCompany,
  pitchedRole: leads.pitchedRole,
  clientHint: leads.clientHint,
  statedPay: leads.statedPay,
  statedGeo: leads.statedGeo,
  triageVerdict: sql<string | null>`${leads.triageJson}->>'verdict'`,
  unknownCount: sql<number>`coalesce(jsonb_array_length(${leads.triageJson}->'unknowns'), 0)`.mapWith(Number),
  threadCount: sql<number>`jsonb_array_length(${leads.threadUrls})`.mapWith(Number),
  positionId: leads.positionId,
  nextAction: leads.nextAction,
  lastInboundAt: leads.lastInboundAt,
  lastOutboundAt: leads.lastOutboundAt,
  createdAt: leads.createdAt,
  updatedAt: leads.updatedAt,
};

export type LeadListRow = Awaited<ReturnType<typeof listLeads>>["items"][number];

export type ListLeadsQuery = {
  status?: string;
  lane?: string;
  q?: string;
  includeClosed?: boolean;
  pageSize?: number;
  page?: number;
  cursor?: string;
};

/**
 * Lean lead rows, newest activity first. Cursor paging by keyset on
 * (updated_at, id), bound to the filters it was issued for.
 */
export async function listLeads(query: ListLeadsQuery = {}) {
  const db = await getDb();
  const pageSize = Math.min(Math.max(query.pageSize ?? 50, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const conds: SQL[] = [];
  const statuses = (query.status || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.length && statuses[0] !== "all") conds.push(inArray(leads.status, statuses.map(parseLeadStatus)));
  else if (!statuses.length && !query.includeClosed) conds.push(notInArray(leads.status, [...LEAD_TERMINAL_STATUSES]));
  const lane = query.lane?.trim();
  if (lane) {
    if (!(LEAD_BUCKETS as readonly string[]).includes(lane)) throw new Error(`lane must be ${LEAD_BUCKETS.join("|")}`);
    conds.push(sql`(${BUCKET}) = ${lane}`);
  }
  const q = query.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conds.push(or(ilike(leads.recruiterName, like), ilike(leads.recruiterCompany, like), ilike(leads.pitchedRole, like), ilike(leads.clientHint, like), ilike(leads.notes, like))!);
  }
  const fingerprint = filterFingerprint({ status: query.status, lane, q, includeClosed: query.includeClosed ? "true" : undefined });
  const cursor = query.cursor ? decodeCursor(query.cursor, { s: "updated_desc", f: fingerprint }) : null;
  const where = conds.length ? and(...conds) : undefined;
  const pageWhere = cursor?.k ? and(...conds, sql`(${leads.updatedAt}, ${leads.id}) < (${cursor.k[0]}::timestamptz, ${cursor.k[1]})`) : where;
  const offset = cursor ? 0 : (page - 1) * pageSize;
  const [rows, totalRow] = await Promise.all([
    db.select({ ...LEAN, cursorTs: sql<string>`to_json(${leads.updatedAt})#>>'{}'` }).from(leads).where(pageWhere)
      .orderBy(desc(leads.updatedAt), desc(leads.id)).limit(pageSize + 1).offset(offset),
    db.select({ c: sql<number>`count(*)::int` }).from(leads).where(where),
  ]);
  const hasMore = rows.length > pageSize;
  const kept = rows.slice(0, pageSize);
  const cursors = kept.map((r) => encodeCursor({ s: "updated_desc", f: fingerprint, k: [r.cursorTs, r.id] }));
  return {
    items: kept.map(({ cursorTs: _c, ...r }) => r),
    total: Number(totalRow[0]?.c ?? 0),
    page,
    pageSize,
    nextCursor: hasMore ? cursors.at(-1) ?? null : null,
    cursors,
  };
}

async function messagesOf(leadId: string, limit = 200) {
  const db = await getDb();
  return db
    .select({ id: outreachEvents.id, direction: outreachEvents.direction, channel: outreachEvents.channel, who: outreachEvents.who, body: outreachEvents.body, occurredAt: outreachEvents.occurredAt, positionId: outreachEvents.positionId })
    .from(outreachEvents)
    .where(eq(outreachEvents.leadId, leadId))
    .orderBy(desc(outreachEvents.occurredAt))
    .limit(limit);
}

async function findLead(leadId: string) {
  const db = await getDb();
  return (await db.select({ ...getTableColumns(leads), bucket: BUCKET }).from(leads).where(eq(leads.id, leadId)).limit(1)).at(0) ?? null;
}

/** Full lead: fields, leadTriage, message log (newest first), interview rounds, linked position id. */
export async function getLead(leadId: string) {
  const row = await findLead(leadId);
  if (!row) return null;
  const { triageJson, ...rest } = row;
  const [messages, rounds] = await Promise.all([messagesOf(leadId), listLeadInterviews(leadId)]);
  return { ...rest, leadTriage: (triageJson as LeadTriage | null) ?? triageOfLead(row, await profileForTriage()), messages, interviews: rounds };
}

/** REST bodies are untyped: accept an array of strings or one string. */
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

function applyFields(input: LeadInput, existing: Lead | null): Partial<typeof leads.$inferInsert> {
  const patch: Partial<typeof leads.$inferInsert> = {};
  for (const k of TEXT_FIELDS) {
    if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = trimOrNull(input[k]);
  }
  if (input.status !== undefined) patch.status = parseLeadStatus(input.status);
  if (input.openUnknowns !== undefined) patch.openUnknowns = uniq(list(input.openUnknowns));
  const threads = [...list(input.threadUrls), input.threadUrl];
  if (threads.some((t) => trimOrNull(t))) patch.threadUrls = uniq([...(existing?.threadUrls || []), ...threads]);
  if (input.metadata !== undefined) patch.metadata = { ...(existing?.metadata || {}), ...(input.metadata || {}) };
  return patch;
}

/**
 * Create or update a lead. With `id` it patches that lead. Otherwise it dedupes
 * on recruiter (profile URL, else email, else name + firm) × pitched role: a
 * second thread from the same recruiter about the same role updates the
 * existing lead and appends its thread URL. An optional first message is
 * logged with phone numbers and emails redacted.
 */
export async function upsertLead(input: LeadInput & { id?: string; message?: LeadMessageInput | null }, actor = "system") {
  const db = await getDb();
  let existing: Lead | null = null;
  if (input.id) {
    existing = (await db.select().from(leads).where(eq(leads.id, input.id)).limit(1)).at(0) ?? null;
    if (!existing) return null;
  }
  const merged = { ...(existing || {}), ...Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined)) } as LeadInput;
  const dedupeKey = existing?.mergedIntoId ? null : leadDedupeKey(merged);
  if (!existing && dedupeKey) existing = (await db.select().from(leads).where(eq(leads.dedupeKey, dedupeKey)).limit(1)).at(0) ?? null;
  if (!existing && !trimOrNull(input.recruiterName) && !trimOrNull(input.recruiterProfileUrl) && !trimOrNull(input.recruiterEmail) && !trimOrNull(input.recruiterCompany)) {
    throw new Error("a lead needs a recruiter: recruiterName, recruiterProfileUrl, recruiterEmail or recruiterCompany");
  }
  const patch = applyFields(input, existing);
  if (existing && !input.id) {
    // Matched on the dedupe key: keep the recruiter URL and role wording first recorded.
    if (existing.recruiterProfileUrl) delete patch.recruiterProfileUrl;
    if (existing.pitchedRole) delete patch.pitchedRole;
  }
  const now = new Date();
  let leadId: string;
  let created = false;
  if (existing) {
    leadId = existing.id;
    if (dedupeKey && dedupeKey !== existing.dedupeKey) {
      const clash = (await db.select({ id: leads.id }).from(leads).where(eq(leads.dedupeKey, dedupeKey)).limit(1)).at(0);
      if (clash && clash.id !== existing.id) throw Object.assign(new Error(`another lead has this recruiter and role: ${clash.id} (merge_leads to combine them)`), { code: "duplicate_lead", leadId: clash.id });
      patch.dedupeKey = dedupeKey;
    }
    await db.update(leads).set({ ...patch, updatedAt: now }).where(eq(leads.id, leadId));
  } else {
    leadId = id("lead");
    created = true;
    await db.insert(leads).values({ id: leadId, status: "new", ...patch, dedupeKey, metadata: { ...(patch.metadata || {}), createdBy: actor }, createdAt: now, updatedAt: now });
  }
  if (input.message) await logLeadMessage(leadId, input.message);
  await retriage(leadId);
  return { lead: await getLead(leadId), created };
}

/**
 * Append a message to the lead's outreach log. Bodies are stored with phone
 * numbers and email addresses redacted. An outbound message moves a new or
 * vetted lead to replied. Never sends anything.
 */
export async function logLeadMessage(leadId: string, input: LeadMessageInput) {
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)).at(0);
  if (!lead) return null;
  const direction: LeadDirection = parseLeadDirection(input.direction);
  const body = trimOrNull(redactContactText(input.body));
  const occurredAt = parseWhen(input.occurredAt) ?? new Date();
  const eid = id("out");
  await db.insert(outreachEvents).values({
    id: eid,
    leadId,
    positionId: lead.positionId,
    channel: trimOrNull(input.channel) || lead.source || "other",
    who: trimOrNull(input.who) || (direction === "inbound" ? lead.recruiterName : null),
    direction,
    body,
    note: body ? body.slice(0, 200) : null,
    occurredAt,
  });
  const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
  if (direction === "inbound" && (!lead.lastInboundAt || occurredAt > lead.lastInboundAt)) patch.lastInboundAt = occurredAt;
  if (direction === "outbound") {
    if (!lead.lastOutboundAt || occurredAt > lead.lastOutboundAt) patch.lastOutboundAt = occurredAt;
    if (lead.status === "new" || lead.status === "vetted") patch.status = "replied";
  }
  const thread = trimOrNull(input.threadUrl);
  if (thread && !lead.threadUrls.includes(thread)) patch.threadUrls = [...lead.threadUrls, thread];
  await db.update(leads).set(patch).where(eq(leads.id, leadId));
  return { id: eid, leadId, direction, channel: trimOrNull(input.channel) || lead.source || "other", body, occurredAt };
}

/** Log a screening round on a lead. A pending round with a time moves the lead to screening_scheduled; a completed one to screened. */
export async function upsertLeadInterview(leadId: string, input: InterviewInput & { id?: string }) {
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)).at(0);
  if (!lead) return null;
  const row = input.id ? await patchLeadInterview(leadId, input.id, input) : await addLeadInterview(leadId, input);
  if (!row) return null;
  if (lead.positionId && !row.positionId) await db.update(interviews).set({ positionId: lead.positionId }).where(eq(interviews.id, row.id));
  const order: LeadStatus[] = ["new", "vetted", "replied", "screening_scheduled", "screened"];
  const next: LeadStatus | null = row.status === "completed" ? "screened" : row.status === "pending" && row.scheduledAt ? "screening_scheduled" : null;
  if (next && order.includes(lead.status) && order.indexOf(next) > order.indexOf(lead.status)) {
    await db.update(leads).set({ status: next, updatedAt: new Date() }).where(eq(leads.id, leadId));
  }
  return { ...row, positionId: row.positionId ?? lead.positionId ?? null };
}

/** Point the lead, its rounds and its messages at a position. Rounds already on another position are left alone. */
async function attachPosition(leadId: string, positionId: string) {
  const db = await getDb();
  await db.update(interviews).set({ positionId, updatedAt: new Date() }).where(and(eq(interviews.leadId, leadId), isNull(interviews.positionId)));
  await db.update(outreachEvents).set({ positionId }).where(and(eq(outreachEvents.leadId, leadId), isNull(outreachEvents.positionId)));
}

/** Link a lead to an existing position without changing its status. */
export async function linkLeadPosition(leadId: string, positionIdOrSlug: string, actor = "system") {
  const { getPosition } = await import("./positions.js");
  const pos = await getPosition(positionIdOrSlug);
  if (!pos) throw Object.assign(new Error("position not found"), { code: "not_found" });
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)).at(0);
  if (!lead) return null;
  await db.update(leads).set({ positionId: pos.id, updatedAt: new Date() }).where(eq(leads.id, leadId));
  await attachPosition(leadId, pos.id);
  await addEvent({ positionId: pos.id, kind: "lead_linked", title: `Recruiter lead linked: ${lead.recruiterName || lead.recruiterCompany || "recruiter"}`, actor, metadata: { leadId } });
  return getLead(leadId);
}

export type PromoteLeadInput = {
  /** Link this existing position. */
  positionIdOrSlug?: string;
  /** Or create/refresh a position from a job URL. */
  url?: string;
  title?: string;
  company?: string;
  /** false: store a manual position from the URL without fetching it. Default true (falls back to manual on a fetch error). */
  fetch?: boolean;
};

/**
 * Promote a lead to a position: link an existing one, or intake a job URL
 * (fetch, or a manual record when the page cannot be read). The lead becomes
 * `promoted` and its rounds and messages are linked to the position.
 */
export async function promoteLead(leadId: string, input: PromoteLeadInput, actor = "system") {
  const db = await getDb();
  const lead = (await db.select().from(leads).where(eq(leads.id, leadId)).limit(1)).at(0);
  if (!lead) return null;
  if (lead.mergedIntoId) throw new Error(`lead was merged into ${lead.mergedIntoId}`);
  const { getPosition, upsertFromJob, recordAtsFetchFailure } = await import("./positions.js");
  let positionId: string | null = null;
  let created = false;
  let fetchFailure: string | undefined;
  if (input.positionIdOrSlug) {
    const pos = await getPosition(input.positionIdOrSlug);
    if (!pos) throw Object.assign(new Error("position not found"), { code: "not_found" });
    positionId = pos.id;
  } else if (input.url?.trim()) {
    const url = input.url.trim();
    const title = trimOrNull(input.title) || lead.pitchedRole || "Recruiter lead";
    const company = trimOrNull(input.company) || lead.clientHint || lead.recruiterCompany || undefined;
    const manual = async () => upsertFromJob({ provider: "other", title, company, url, listingStatus: "unknown", locationRaw: lead.statedGeo || undefined, salaryRaw: lead.statedPay || undefined }, { source: "lead", companyName: company, status: "review" });
    if (input.fetch === false) {
      const r = await manual();
      positionId = r.position.id;
      created = r.created;
    } else {
      try {
        const { intakeUrl } = await import("./scan.js");
        const r = await intakeUrl(url, { companyName: company, status: "review", source: "lead" });
        if (!r.position) throw new Error(r.reason || "intake skipped");
        positionId = r.position.id;
        created = r.created;
      } catch (e) {
        fetchFailure = e instanceof Error ? e.message : String(e);
        const r = await manual();
        positionId = r.position.id;
        created = r.created;
        if (r.created) await recordAtsFetchFailure(positionId, e, "lead");
      }
    }
  } else {
    throw new Error("promote_lead needs positionIdOrSlug or url");
  }
  await db.update(leads).set({ positionId, status: "promoted", updatedAt: new Date() }).where(eq(leads.id, leadId));
  await attachPosition(leadId, positionId);
  await addEvent({ positionId, kind: "lead_promoted", title: `Promoted from recruiter lead: ${lead.recruiterName || lead.recruiterCompany || "recruiter"}`, actor, metadata: { leadId } });
  return { lead: await getLead(leadId), positionId, created, ...(fetchFailure ? { fetchFailure } : {}) };
}

/**
 * Merge leads into `targetId`: messages and rounds move to the target, thread
 * URLs and open unknowns are combined, empty fields on the target are filled.
 * Merged leads are closed with mergedIntoId; nothing is deleted.
 */
export async function mergeLeads(targetId: string, sourceIds: string[], actor = "system") {
  const db = await getDb();
  const ids = [...new Set(sourceIds.filter((s) => s && s !== targetId))];
  if (!ids.length) throw new Error("sourceIds must name at least one other lead");
  const target = (await db.select().from(leads).where(eq(leads.id, targetId)).limit(1)).at(0);
  if (!target) return null;
  const sources = await db.select().from(leads).where(inArray(leads.id, ids));
  if (sources.length !== ids.length) throw Object.assign(new Error("lead not found"), { code: "not_found" });
  const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
  for (const k of TEXT_FIELDS) {
    if (target[k]) continue;
    const v = sources.map((s) => s[k]).find(Boolean);
    if (v) (patch as Record<string, unknown>)[k] = v;
  }
  patch.threadUrls = uniq([...target.threadUrls, ...sources.flatMap((s) => s.threadUrls)]);
  patch.openUnknowns = uniq([...target.openUnknowns, ...sources.flatMap((s) => s.openUnknowns)]);
  const latest = (xs: Array<Date | null>) => xs.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime()).at(0) ?? null;
  patch.lastInboundAt = latest([target.lastInboundAt, ...sources.map((s) => s.lastInboundAt)]);
  patch.lastOutboundAt = latest([target.lastOutboundAt, ...sources.map((s) => s.lastOutboundAt)]);
  if (!target.positionId) patch.positionId = sources.map((s) => s.positionId).find(Boolean) ?? null;
  await db.update(interviews).set({ leadId: targetId }).where(inArray(interviews.leadId, ids));
  await db.update(outreachEvents).set({ leadId: targetId }).where(inArray(outreachEvents.leadId, ids));
  await db.update(leads).set({ status: "closed", closedReason: "merged", mergedIntoId: targetId, dedupeKey: null, updatedAt: new Date() }).where(inArray(leads.id, ids));
  await db.update(leads).set({ ...patch, metadata: { ...target.metadata, mergedFrom: uniq([...((target.metadata.mergedFrom as string[] | undefined) || []), ...ids]), mergedBy: actor } }).where(eq(leads.id, targetId));
  const positionId = patch.positionId ?? target.positionId;
  if (positionId) await attachPosition(targetId, positionId);
  await retriage(targetId);
  return getLead(targetId);
}

/** Active leads for the work queue, ordered by bucket (call_soon first) then latest activity. */
export async function leadQueue(opts: { limit: number; page: number }) {
  const db = await getDb();
  const where = notInArray(leads.status, [...LEAD_TERMINAL_STATUSES]);
  const order = sql`case (${BUCKET}) when 'call_soon' then 0 when 'needs_reply' then 1 when 'waiting' then 2 else 3 end`;
  const [rows, totalRow] = await Promise.all([
    db.select(LEAN).from(leads).where(where).orderBy(order, desc(leads.updatedAt), desc(leads.id)).limit(opts.limit).offset((opts.page - 1) * opts.limit),
    db.select({ c: sql<number>`count(*)::int` }).from(leads).where(where),
  ]);
  return { items: rows, total: Number(totalRow[0]?.c ?? 0) };
}
