import { describe, it, expect } from 'vitest';
import { normalizeMsisdn, parseCallback } from '../src/domains/payments/daraja.js';

describe('M-Pesa MSISDN normalization', () => {
  it('normalizes common Kenyan formats to 2547########', () => {
    expect(normalizeMsisdn('0712345678')).toBe('254712345678');
    expect(normalizeMsisdn('712345678')).toBe('254712345678');
    expect(normalizeMsisdn('254712345678')).toBe('254712345678');
    expect(normalizeMsisdn('+254 712 345 678')).toBe('254712345678');
  });
});

describe('Daraja callback parsing', () => {
  it('parses a successful STK callback with receipt + amount', () => {
    const body = {
      Body: { stkCallback: {
        CheckoutRequestID: 'ws_CO_123',
        ResultCode: 0,
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: 500 },
          { Name: 'MpesaReceiptNumber', Value: 'QABC123' },
        ] },
      } },
    };
    const r = parseCallback(body);
    expect(r?.checkoutRequestId).toBe('ws_CO_123');
    expect(r?.success).toBe(true);
    expect(r?.receipt).toBe('QABC123');
    expect(r?.amount).toBe(500);
  });

  it('parses a failed callback (non-zero ResultCode)', () => {
    const r = parseCallback({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_9', ResultCode: 1032 } } });
    expect(r?.success).toBe(false);
    expect(r?.checkoutRequestId).toBe('ws_CO_9');
  });

  it('returns null for a non-Daraja body (simulation shape)', () => {
    expect(parseCallback({ checkout_request_id: 'x', outcome: 'success' })).toBeNull();
    expect(parseCallback({})).toBeNull();
  });
});
