/**
 * @purpose Validates and normalizes a discount code before applying it.
 * @requirement REQ-042
 * @contract pre: code is non-empty string.
 *   post: returns normalized code.
 *   throws: InvalidDiscountError when code fails the format check.
 *   side-effects: none.
 * @audience technical, business
 */
export function normalizeDiscountCode(code: string): string {
  if (!code) {
    throw new InvalidDiscountError("code must not be empty");
  }
  return code.trim().toUpperCase();
}

export class InvalidDiscountError extends Error {}
