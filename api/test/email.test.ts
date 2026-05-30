import { describe, it, expect } from 'vitest';
import { buildSendgridPayload } from '../src/domains/notifications/email.js';
import { config } from '../src/config.js';

describe('SendGrid payload', () => {
  it('builds a v3 mail/send body', () => {
    const p = buildSendgridPayload('user@example.com', 'Receipt', 'Thank you', 'no-reply@jtm.example') as any;
    expect(p.personalizations[0].to[0].email).toBe('user@example.com');
    expect(p.from.email).toBe('no-reply@jtm.example');
    expect(p.subject).toBe('Receipt');
    expect(p.content[0]).toEqual({ type: 'text/plain', value: 'Thank you' });
  });
});

describe('email config gating', () => {
  it('defaults to simulation mode without an API key', () => {
    expect(config.email.simulated).toBe(true);
  });
});
