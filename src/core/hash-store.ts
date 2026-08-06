import { createHash } from "node:crypto";

export function computeContentHash(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}

export function isStale(previousHash: string | undefined, currentSourceText: string): boolean {
  if (previousHash === undefined) return true;
  return previousHash !== computeContentHash(currentSourceText);
}
