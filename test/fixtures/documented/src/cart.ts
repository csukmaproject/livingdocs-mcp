/**
 * @purpose Computes the final cart total after a discount is applied.
 * @requirement REQ-043
 * @contract pre: items is a non-empty array of positive prices.
 *   post: returns the total rounded to two decimals.
 *   side-effects: none.
 * @audience technical
 */
export function computeTotal(items: number[], discountPercent: number): number {
  const subtotal = items.reduce((sum, price) => sum + price, 0);
  const discounted = subtotal * (1 - discountPercent / 100);
  return Math.round(discounted * 100) / 100;
}
