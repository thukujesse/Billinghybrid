import { describe, it, expect } from 'vitest';
import { registry, paymentsTotal, httpDuration } from '../src/lib/metrics.js';

describe('metrics registry', () => {
  it('renders counters with labels in Prometheus format', () => {
    paymentsTotal.inc({ provider: 'mpesa', status: 'success' });
    paymentsTotal.inc({ provider: 'mpesa', status: 'success' });
    paymentsTotal.inc({ provider: 'stripe', status: 'failed' });
    const out = registry.render();
    expect(out).toContain('# TYPE jtm_payments_total counter');
    expect(out).toMatch(/jtm_payments_total\{provider="mpesa",status="success"\} 2/);
    expect(out).toMatch(/jtm_payments_total\{provider="stripe",status="failed"\} 1/);
  });

  it('renders histogram buckets, sum and count', () => {
    httpDuration.observe(0.02, { route: '/x' });
    httpDuration.observe(0.3, { route: '/x' });
    const out = registry.render();
    expect(out).toContain('# TYPE jtm_http_request_duration_seconds histogram');
    expect(out).toContain('jtm_http_request_duration_seconds_bucket');
    expect(out).toContain('le="+Inf"');
    expect(out).toContain('jtm_http_request_duration_seconds_count');
    expect(out).toContain('jtm_http_request_duration_seconds_sum');
  });

  it('produces valid exposition text (HELP/TYPE headers present)', () => {
    const out = registry.render();
    expect(out).toContain('# HELP jtm_http_requests_total');
    expect(out.split('\n').every((l) => l === '' || l.startsWith('#') || /\S+ -?\d/.test(l))).toBe(true);
  });
});
