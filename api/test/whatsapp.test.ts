import { describe, it, expect } from 'vitest';
import { toWaId, buildTemplatePayload } from '../src/domains/notifications/whatsapp.js';
import { config } from '../src/config.js';

describe('WhatsApp wa_id normalization', () => {
  it('normalizes KE numbers to country-coded digits without +', () => {
    expect(toWaId('0712345678')).toBe('254712345678');
    expect(toWaId('+254 712 345 678')).toBe('254712345678');
    expect(toWaId('254712345678')).toBe('254712345678');
  });
});

describe('WhatsApp template payload', () => {
  it('builds a template message with ordered body params', () => {
    const p = buildTemplatePayload('0712345678', 'payment_receipt', ['KES 300.00'], 'en') as any;
    expect(p.type).toBe('template');
    expect(p.to).toBe('254712345678');
    expect(p.template.name).toBe('payment_receipt');
    expect(p.template.language.code).toBe('en');
    expect(p.template.components[0].type).toBe('body');
    expect(p.template.components[0].parameters).toEqual([{ type: 'text', text: 'KES 300.00' }]);
  });

  it('omits components when there are no params', () => {
    const p = buildTemplatePayload('254700000000', 'hello_world', [], 'sw') as any;
    expect(p.template.components).toBeUndefined();
    expect(p.template.language.code).toBe('sw');
  });
});

describe('WhatsApp config gating', () => {
  it('defaults to simulation mode without credentials', () => {
    // No WA_* env in the test environment -> simulated.
    expect(config.whatsapp.simulated).toBe(true);
  });
});
