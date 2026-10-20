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

/** A status write that comes from the career-ops sync rather than a decision made in job-scout. */
export function isCareerOpsOrigin(o: { actor?: string | null; note?: string | null; source?: string | null }): boolean {
  return o.source === "career-ops" || o.actor === "career-ops" || /^career-ops\b/i.test((o.note || "").trim());
}

const DROP_STATUSES = new Set(["skip", "archived"]);

/**
 * Set a status from an MCP/API caller. A skip or archive that originates from
 * the career-ops sync is not applied: it is recorded as a timeline note, so a
 * tracker label never removes a role from the pipeline on its own.
 */
export async function setStatusFromCaller(idOrSlug: string, status: string, o: { actor: string; reason?: string; note?: string; source?: string }) {
  const pos = await getPosition(idOrSlug);
  if (!pos) return null;
  if (DROP_STATUSES.has(status) && isCareerOpsOrigin(o)) {
    await addEvent({
      positionId: pos.id,
      kind: "note",
      title: `career-ops says ${status}; not applied`.slice(0, 300),
      body: [o.note, o.reason].filter(Boolean).join("\n") || "A career-ops tracker decision does not skip or archive a job-scout position automatically.",
      actor: o.actor,
      metadata: { careerOps: { requestedStatus: status, applied: false } },
    });
    return { ...(await getPosition(pos.id))!, statusApplied: false as const, statusNote: "career-ops skip/archive recorded as a note" };
  }
  if (status === "archived") return archivePosition(pos.id, o.reason || "mcp", o.actor);
  return patchPosition(pos.id, { status }, o.actor);
}

/** Record that a tracker row asked to drop a role, without changing its status. */
export async function noteCareerOpsDrop(positionId: string, trackerStatus: string, actor = "career-ops") {
  await addEvent({ positionId, kind: "note", title: `career-ops tracker status ${trackerStatus}; not applied`.slice(0, 300), actor, metadata: { careerOps: { trackerStatus, applied: false } } });
}
