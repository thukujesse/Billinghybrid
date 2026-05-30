import { describe, it, expect } from 'vitest';
import { toWaId } from '../src/domains/notifications/whatsapp.js';
import { config } from '../src/config.js';

describe('WhatsApp wa_id normalization', () => {
  it('normalizes KE numbers to country-coded digits without +', () => {
    expect(toWaId('0712345678')).toBe('254712345678');
    expect(toWaId('+254 712 345 678')).toBe('254712345678');
    expect(toWaId('254712345678')).toBe('254712345678');
  });
});

describe('WhatsApp config gating', () => {
  it('defaults to simulation mode without credentials', () => {
    // No WA_* env in the test environment -> simulated.
    expect(config.whatsapp.simulated).toBe(true);
  });
});
