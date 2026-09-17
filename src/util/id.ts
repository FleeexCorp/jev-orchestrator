import { randomBytes } from "node:crypto";

const SHORT_ID_BYTES = 3;

/** Six hex chars, enough to disambiguate worker and worktree names. */
export function shortId(): string {
  return randomBytes(SHORT_ID_BYTES).toString("hex");
}

const SLUG_MAX_LENGTH = 40;

/** Lowercase, hyphenated, filesystem and git-ref safe. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "task";
}
