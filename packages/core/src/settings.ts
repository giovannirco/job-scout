import { eq } from "drizzle-orm";
import { getDb, settings } from "@job-scout/db";
import { resolveSettings, type Settings } from "@job-scout/shared";

const ROW_ID = "default";
let cache: { at: number; value: Settings } | null = null;
const TTL_MS = 5_000;

export async function getSettings(opts: { fresh?: boolean } = {}): Promise<Settings> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const db = await getDb();
  const row = (await db.select().from(settings).where(eq(settings.id, ROW_ID)).limit(1))[0];
  const value = resolveSettings(row?.data);
  cache = { at: Date.now(), value };
  return value;
}

/** Shallow-per-section merge: patch = { gate: {...}, llm: { operations: {...} } } */
export async function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const db = await getDb();
  const current = await getSettings({ fresh: true });
  const next = deepMerge(current as unknown as Record<string, unknown>, patch);
  const value = resolveSettings(next);
  await db
    .insert(settings)
    .values({ id: ROW_ID, data: value as unknown as Record<string, unknown>, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.id,
      set: { data: value as unknown as Record<string, unknown>, updatedAt: new Date() },
    });
  cache = { at: Date.now(), value };
  return value;
}

export function invalidateSettingsCache() {
  cache = null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    else out[k] = v;
  }
  return out;
}
