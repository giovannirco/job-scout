import type { GeoClass, Workplace } from "@job-scout/shared";

/**
 * A person's workplace/geo call for a position (update_position, PATCH). Stored
 * in metadata.classificationOverride and applied over every automatic
 * classification: ATS snapshots, listing_classify, backfills and repairs.
 */
export type ClassificationOverride = { workplace?: Workplace; geoClass?: GeoClass; actor?: string; at?: string };

export function classificationOverride(metadata: Record<string, unknown> | null | undefined): ClassificationOverride {
  const o = metadata?.classificationOverride;
  return o && typeof o === "object" ? (o as ClassificationOverride) : {};
}

/** Replace overridden fields of computed facts with the person's values. */
export function applyClassificationOverride<T extends { workplace?: string | null; geoClass?: string | null }>(
  metadata: Record<string, unknown> | null | undefined,
  facts: T,
): T {
  const o = classificationOverride(metadata);
  if (!o.workplace && !o.geoClass) return facts;
  return { ...facts, ...(o.workplace ? { workplace: o.workplace } : {}), ...(o.geoClass ? { geoClass: o.geoClass } : {}) };
}

/** Both fields are pinned by a person: no model classification can change anything. */
export function fullyOverridden(metadata: Record<string, unknown> | null | undefined): boolean {
  const o = classificationOverride(metadata);
  return Boolean(o.workplace && o.geoClass);
}
