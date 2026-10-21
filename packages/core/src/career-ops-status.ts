import { isCareerOpsActor } from "@job-scout/shared";
import { addEvent } from "./timeline.js";
import { archivePosition, getPosition, patchPosition } from "./positions.js";

/**
 * career-ops tracker statuses -> job-scout statuses. Tracker decisions to drop
 * a role (Discarded, SKIP, Withdrawn) are not mapped: they never skip or
 * archive a position automatically; callers record a timeline note instead.
 */
export function mapCareerOpsStatus(s?: string | null): string | null {
  if (!s) return null;
  const table = new Map<string, string>([
    ["to apply", "review"],
    ["to-apply", "review"],
    ["evaluated", "review"],
    ["applied", "applied"],
    ["screen", "screen"],
    ["screening", "screen"],
    ["interview", "interview"],
    ["interviewing", "interview"],
    ["offer", "offer"],
    ["rejected", "rejected"],
    ["declined", "rejected"],
    ["ghosted", "rejected"],
  ]);
  return table.get(s.toLowerCase().trim()) ?? null;
}

/** Tracker labels that mean "drop this role" (Discarded, SKIP, SKIP-cash, Withdrawn, …). */
export const careerOpsDropStatus = (s?: string | null) => /^(discard(ed)?|skip(ped)?(\b.*)?|withdrawn)$/i.test(String(s || "").trim());

/**
 * A status write that comes from the career-ops sync rather than a decision made
 * in job-scout: `source: "career-ops"`, a note starting with "career-ops", or a
 * calling actor (the MCP token name) of "career-ops" / "career-ops…".
 */
export function isCareerOpsOrigin(o: { actor?: string | null; note?: string | null; source?: string | null }): boolean {
  return /^career-ops$/i.test((o.source || "").trim()) || isCareerOpsActor(o.actor) || /^career-ops\b/i.test((o.note || "").trim());
}

const DROP_STATUSES = new Set(["skip", "archived"]);

type CallerOrigin = { actor: string; reason?: string; note?: string; source?: string };

async function noteCareerOpsRequest(positionId: string, status: string, o: CallerOrigin) {
  await addEvent({
    positionId,
    kind: "note",
    title: `career-ops says ${status}; not applied`.slice(0, 300),
    body: [o.note, o.reason].filter(Boolean).join("\n") || "A career-ops tracker decision does not skip or archive a job-scout position automatically.",
    actor: o.actor,
    metadata: { careerOps: { requestedStatus: status, applied: false } },
  });
}

/**
 * Set a status from an MCP/API caller. A skip or archive that originates from
 * the career-ops sync is not applied: it is recorded as a timeline note, so a
 * tracker label never removes a role from the pipeline on its own.
 */
export async function setStatusFromCaller(idOrSlug: string, status: string, o: CallerOrigin) {
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  if (DROP_STATUSES.has(status) && isCareerOpsOrigin(o)) {
    await noteCareerOpsRequest(pos.id, status, o);
    return { ...(await getPosition(pos.id))!, statusApplied: false as const, statusNote: "career-ops skip/archive recorded as a note" };
  }
  if (status === "archived") return archivePosition(pos.id, o.reason || "mcp", o.actor);
  return patchPosition(pos.id, { status }, o.actor);
}

/**
 * PATCH a position from an MCP/API caller (update_position). The same career-ops
 * guard as setStatusFromCaller applies to a `status` of skip/archived in the
 * patch: that status is dropped and noted, and the rest of the patch applies.
 */
export async function patchFromCaller(idOrSlug: string, patch: Record<string, unknown>, o: CallerOrigin) {
  const status = typeof patch.status === "string" ? patch.status : null;
  if (!status || !DROP_STATUSES.has(status) || !isCareerOpsOrigin(o)) return patchPosition(idOrSlug, patch, o.actor);
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  const rest = { ...patch };
  delete rest.status;
  await noteCareerOpsRequest(pos.id, status, o);
  if (Object.keys(rest).length) await patchPosition(pos.id, rest, o.actor);
  return { ...(await getPosition(pos.id))!, statusApplied: false as const, statusNote: "career-ops skip/archive recorded as a note" };
}

/** Record that a tracker row asked to drop a role, without changing its status. */
export async function noteCareerOpsDrop(positionId: string, trackerStatus: string, actor = "career-ops") {
  await addEvent({ positionId, kind: "note", title: `career-ops tracker status ${trackerStatus}; not applied`.slice(0, 300), actor, metadata: { careerOps: { trackerStatus, applied: false } } });
}
