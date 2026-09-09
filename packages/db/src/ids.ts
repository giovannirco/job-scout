import { nanoid } from "nanoid";

export function id(prefix?: string): string {
  const n = nanoid(12);
  return prefix ? `${prefix}_${n}` : n;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
