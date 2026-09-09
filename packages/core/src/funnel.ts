import { POSITION_STATUSES, type PositionStatus } from "@job-scout/db";

export const FUNNEL_WINDOW_MS = 30 * 86_400_000;
export const APPLIED_WEEK_MS = 7 * 86_400_000;

export type FunnelRow = {
  status: string;
  firstSeenAt: Date | null;
  appliedAt: Date | null;
};

export function emptyStatusCounts(): Record<PositionStatus, number> {
  return Object.fromEntries(POSITION_STATUSES.map((s) => [s, 0])) as Record<PositionStatus, number>;
}

export function countFunnel(rows: FunnelRow[], now = new Date()): { last30d: Record<PositionStatus, number>; appliedThisWeek: number } {
  const last30d = emptyStatusCounts();
  const since30 = now.getTime() - FUNNEL_WINDOW_MS;
  const sinceWeek = now.getTime() - APPLIED_WEEK_MS;
  let appliedThisWeek = 0;
  for (const r of rows) {
    if (r.firstSeenAt && r.firstSeenAt.getTime() >= since30 && r.status in last30d) {
      last30d[r.status as PositionStatus] += 1;
    }
    if (r.appliedAt && r.appliedAt.getTime() >= sinceWeek) appliedThisWeek += 1;
  }
  return { last30d, appliedThisWeek };
}
