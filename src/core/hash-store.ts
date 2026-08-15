/**
 * @purpose Computes and compares content hashes used to detect whether a source entity's text has changed since it was last documented.
 * @audience technical
 */
import { createHash } from "node:crypto";

/**
 * @purpose Produces a stable content hash for a piece of source text, used as the basis for detecting whether a documented entity has changed.
 * @contract pre: none.
 *   post: returns the lowercase hex-encoded SHA-256 digest of sourceText.
 *   side-effects: none.
 * @audience technical
 */
export function computeContentHash(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}

/**
 * @purpose Determines whether a previously recorded content hash no longer matches the current source, signaling that a node's documentation may be stale.
 * @contract pre: none.
 *   post: returns true when previousHash is undefined (nothing recorded yet) or when it differs from the hash of currentSourceText; returns false when they match.
 *   side-effects: none.
 * @audience technical
 */
export function isStale(previousHash: string | undefined, currentSourceText: string): boolean {
  if (previousHash === undefined) return true;
  return previousHash !== computeContentHash(currentSourceText);
}
