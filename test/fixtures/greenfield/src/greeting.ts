/**
 * @purpose Raised when a greeting is requested for an empty or blank name.
 * @requirement REQ-001
 * @audience technical
 */
export class BlankNameError extends Error {}

/**
 * @purpose Builds a friendly greeting for a person's name.
 * @requirement REQ-001
 * @contract pre: name is a non-empty, non-blank string.
 *   post: returns "Hello, <name>!" with the name trimmed.
 *   throws: BlankNameError when name is empty or all whitespace.
 *   side-effects: none.
 * @audience technical, business
 */
export function buildGreeting(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new BlankNameError("name must not be blank");
  }
  return `Hello, ${trimmed}!`;
}
