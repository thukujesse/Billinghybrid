import { describe, it, expect, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';
import { createRouter, assignSubscriber, routerForSubscriber } from '../src/domains/routers/service.js';
import { provisioning } from '../src/domains/provisioning/service.js';
import { mikrotikAdapter } from '../src/domains/network/mikrotik.js';

const tag = Date.now().toString().slice(-7);

afterAll(async () => { await pool.end(); });

describe('router registry', () => {
  it('creates a router and homes a subscriber on it', async () => {
    const sub = await createSubscriber({ full_name: 'Net User', phone: `7${tag}01`, type: 'pppoe', pppoe_username: `net_${tag}` });
    const router = await createRouter({ name: `Edge-${tag}`, host: '10.0.0.1', site: 'HQ' });
    await assignSubscriber(sub.id, router.id);
    const homed = await routerForSubscriber(sub.id);
    expect(homed?.id).toBe(router.id);
    expect(homed?.host).toBe('10.0.0.1');
  });
});

describe('mikrotik adapter', () => {
  it('maps suspend to the right RouterOS sentences', async () => {
    const r = await mikrotikAdapter.apply('suspend', {
      subscriberId: 'x',
      pppoeUsername: 'bob',
      router: { id: 'r', name: 'Edge', host: '10.0.0.1', api_port: 8728, type: 'mikrotik' },
    });
    expect(r.ok).toBe(true);
    expect(r.note).toContain('/ppp/secret/set [find name="bob"] disabled=yes');
    expect(r.note).toContain('/ppp/active/remove');
  });
});

describe('provisioning records adapter outcome', () => {
  it('writes a provisioning_action referencing the router', async () => {
    const sub = await createSubscriber({ full_name: 'Prov User', phone: `7${tag}02`, type: 'pppoe', pppoe_username: `prov_${tag}` });
    const router = await createRouter({ name: `Edge2-${tag}`, host: '10.0.0.9' });
    await assignSubscriber(sub.id, router.id);

    await provisioning.suspend(sub.id, { reason: 'test' });

    const row = await query(
      `SELECT action, status, detail FROM provisioning_actions
       WHERE subscriber_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [sub.id]
    );
    expect(row.rows[0].action).toBe('suspend');
    expect(row.rows[0].status).toBe('applied');
    expect(JSON.stringify(row.rows[0].detail)).toContain('10.0.0.9');
  });
});
