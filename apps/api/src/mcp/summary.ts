/**
 * Compact echoes for MCP write tools. A full position carries triageJson and
 * metadata (ATS questions, career-ops stamp, form harvest), which pushed write
 * results toward the result cap; callers re-read with get_position when they
 * need more. `verbose: true` on the tool returns the full row instead.
 */

type PositionLike = {
  id: string;
  slug: string;
  title: string;
  status: string;
  archiveReason?: string | null;
  priority?: string | null;
  primaryUrl?: string | null;
  workplace?: string | null;
  geoClass?: string | null;
  geoNotes?: string | null;
  listingStatus?: string | null;
  nextAction?: string | null;
  notes?: string | null;
  resumeSurface?: string | null;
  watchEnabled?: boolean | null;
  appliedAt?: Date | string | null;
  lastChangedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
  company?: { id?: string; slug?: string; name?: string } | null;
  statusApplied?: boolean;
  statusNote?: string;
};

const NOTES_MAX = 2_000;

export function positionSummary(p: PositionLike) {
  const careerOps = p.metadata?.careerOps as Record<string, unknown> | undefined;
  const override = p.metadata?.classificationOverride as Record<string, unknown> | undefined;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    company: p.company ? { slug: p.company.slug, name: p.company.name } : null,
    status: p.status,
    archiveReason: p.archiveReason ?? null,
    priority: p.priority ?? null,
    primaryUrl: p.primaryUrl ?? null,
    workplace: p.workplace ?? null,
    geoClass: p.geoClass ?? null,
    geoNotes: p.geoNotes ?? null,
    listingStatus: p.listingStatus ?? null,
    nextAction: p.nextAction ?? null,
    notes: p.notes && p.notes.length > NOTES_MAX ? `${p.notes.slice(0, NOTES_MAX)}… (${p.notes.length} chars)` : (p.notes ?? null),
    resumeSurface: p.resumeSurface ?? null,
    watchEnabled: p.watchEnabled ?? null,
    appliedAt: p.appliedAt ?? null,
    lastChangedAt: p.lastChangedAt ?? null,
    updatedAt: p.updatedAt ?? null,
    ...(careerOps ? { careerOps: { trackerId: careerOps.trackerId, status: careerOps.status, score: careerOps.score } } : {}),
    ...(override ? { classificationOverride: override } : {}),
    ...(p.statusApplied !== undefined ? { statusApplied: p.statusApplied, statusNote: p.statusNote } : {}),
  };
}

type InterviewLike = {
  id: string;
  positionId: string;
  stage: string;
  title?: string | null;
  interviewerName?: string | null;
  interviewerRole?: string | null;
  scheduledAt?: Date | string | null;
  occurredAt?: Date | string | null;
  durationSeconds?: number | null;
  status: string;
  outcome?: string | null;
  transcriptSource?: string | null;
  sourcePath?: string | null;
  notes?: string | null;
  notesMarkdown?: string | null;
  reviewMarkdown?: string | null;
  transcriptMarkdown?: string | null;
  aiBriefMarkdown?: string | null;
  aiBriefedAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  briefJobId?: string | null;
};

const chars = (s?: string | null) => s?.length ?? 0;

/** Round metadata plus char counts, the shape list_interviews returns; bodies via get_interview. */
export function interviewSummary(r: InterviewLike) {
  return {
    id: r.id,
    positionId: r.positionId,
    stage: r.stage,
    title: r.title ?? null,
    interviewerName: r.interviewerName ?? null,
    interviewerRole: r.interviewerRole ?? null,
    scheduledAt: r.scheduledAt ?? null,
    occurredAt: r.occurredAt ?? null,
    durationSeconds: r.durationSeconds ?? null,
    status: r.status,
    outcome: r.outcome ?? null,
    transcriptSource: r.transcriptSource ?? null,
    sourcePath: r.sourcePath ?? null,
    notesChars: chars(r.notes),
    notesMarkdownChars: chars(r.notesMarkdown),
    reviewChars: chars(r.reviewMarkdown),
    transcriptChars: chars(r.transcriptMarkdown),
    aiBriefChars: chars(r.aiBriefMarkdown),
    aiBriefedAt: r.aiBriefedAt ?? null,
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
    briefJobId: r.briefJobId ?? null,
  };
}
