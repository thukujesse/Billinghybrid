/**
 * Money helpers. We store and compute in integer minor units (cents) and only
 * format to a decimal string at the edges. Never use floats for arithmetic.
 */

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function formatMoney(cents: number, currency = 'KES'): string {
  const value = (cents / 100).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${value}`;
}

/**
 * Apply a tax rate expressed in basis points to a subtotal (in cents).
 * Returns the rounded tax amount in cents. 1600 bps = 16%.
 */
export function taxOf(subtotalCents: number, rateBps: number): number {
  return Math.round((subtotalCents * rateBps) / 10_000);
}
