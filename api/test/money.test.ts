import { describe, it, expect } from 'vitest';
import { toCents, fromCents, taxOf, formatMoney } from '../src/lib/money.js';

describe('money', () => {
  it('converts to/from cents without float drift', () => {
    expect(toCents(2500)).toBe(250000);
    expect(toCents(19.99)).toBe(1999);
    expect(fromCents(250000)).toBe(2500);
  });

  it('computes VAT (16% = 1600 bps) with correct rounding', () => {
    expect(taxOf(250000, 1600)).toBe(40000); // 2500.00 -> 400.00 tax
    expect(taxOf(5000, 1600)).toBe(800); // 50.00 -> 8.00
    expect(taxOf(333, 1600)).toBe(53); // rounds 53.28 -> 53
  });

  it('formats money', () => {
    expect(formatMoney(250000, 'KES')).toBe('KES 2,500.00');
  });
});
