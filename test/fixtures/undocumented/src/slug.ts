export class EmptyTitleError extends Error {}

export function slugify(title: string): string {
  if (!title.trim()) {
    throw new EmptyTitleError("title must not be empty");
  }
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
