import { and, desc, eq } from "drizzle-orm";
import { getDb, id, people } from "@job-scout/db";

export type PersonInput = {
  name?: string;
  title?: string | null;
  linkedinUrl?: string | null;
  email?: string | null;
  notes?: string | null;
};

const PERSON_ROW = {
  id: people.id,
  companyId: people.companyId,
  name: people.name,
  title: people.title,
  linkedinUrl: people.linkedinUrl,
  email: people.email,
  notes: people.notes,
  createdAt: people.createdAt,
};

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

export async function listPeople(companyId: string) {
  const db = await getDb();
  return db.select(PERSON_ROW).from(people).where(eq(people.companyId, companyId)).orderBy(desc(people.createdAt));
}

export async function addPerson(companyId: string, input: PersonInput) {
  const name = (input.name || "").trim();
  if (!name) throw new Error("name required");
  const db = await getDb();
  const pid = id("pe");
  await db.insert(people).values({
    id: pid,
    companyId,
    name,
    title: trimOrNull(input.title),
    linkedinUrl: trimOrNull(input.linkedinUrl),
    email: trimOrNull(input.email),
    notes: trimOrNull(input.notes),
    metadata: {},
  });
  const row = (await db.select(PERSON_ROW).from(people).where(eq(people.id, pid)))[0];
  if (!row) throw new Error("person insert failed");
  return row;
}

export async function deletePerson(companyId: string, personId: string) {
  const db = await getDb();
  const row = (
    await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, personId), eq(people.companyId, companyId)))
      .limit(1)
  )[0];
  if (!row) return false;
  await db.delete(people).where(eq(people.id, personId));
  return true;
}
