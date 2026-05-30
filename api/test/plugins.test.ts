import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, query } from '../src/db/pool.js';
import { register, loadPlugins, listPlugins, _reset } from '../src/plugins/registry.js';
import { loyaltyPointsPlugin } from '../src/plugins/builtin/loyaltyPoints.js';
import { emit } from '../src/domains/events/bus.js';
import type { Plugin } from '../src/plugins/types.js';
import { createSubscriber } from '../src/domains/subscribers/service.js';

const tag = Date.now().toString().slice(-7);

beforeEach(() => _reset());
afterAll(async () => { await pool.end(); });

describe('plugin registry', () => {
  it('loads an enabled plugin and records its hooks/routes', async () => {
    let hookFired = false;
    const p: Plugin = {
      manifest: { id: `t-${tag}`, name: 'Test', version: '0.1.0' },
      register(ctx) {
        ctx.on('test.topic', () => { hookFired = true; });
        ctx.router.get('/ping', (_req, res) => res.json({ ok: true }));
      },
    };
    register(p);
    await loadPlugins();

    const listed = listPlugins().find((l) => l.manifest.id === `t-${tag}`);
    expect(listed?.enabled).toBe(true);
    expect(listed?.hooks).toBe(1);
    expect(listed?.routes).toBe(1);

    await emit('test.topic', {});
    expect(hookFired).toBe(true);
  });

  it('skips a plugin disabled via PLUGINS_DISABLED', async () => {
    process.env.PLUGINS_DISABLED = `off-${tag}`;
    const p: Plugin = {
      manifest: { id: `off-${tag}`, name: 'Off', version: '1.0.0' },
      register(ctx) { ctx.router.get('/x', (_r, res) => res.end()); },
    };
    register(p);
    await loadPlugins();
    const listed = listPlugins().find((l) => l.manifest.id === `off-${tag}`);
    expect(listed?.enabled).toBe(false);
    expect(listed?.routes).toBe(0);
    delete process.env.PLUGINS_DISABLED;
  });

  it('isolates a failing plugin without throwing', async () => {
    const bad: Plugin = {
      manifest: { id: `bad-${tag}`, name: 'Bad', version: '1.0.0' },
      register() { throw new Error('boom'); },
    };
    register(bad);
    await expect(loadPlugins()).resolves.toBeDefined();
    expect(listPlugins().find((l) => l.manifest.id === `bad-${tag}`)?.enabled).toBe(false);
  });
});

describe('loyalty-points builtin plugin', () => {
  it('awards points on payment.paid', async () => {
    register(loyaltyPointsPlugin);
    await loadPlugins();

    const sub = await createSubscriber({ full_name: 'Loyal', phone: `2${tag}11` });
    // KES 500.00 paid = 50000 cents -> floor(50000/100/100) = 5 points
    await emit('payment.paid', { subscriberId: sub.id, amount: 50000 });

    const r = await query<{ points: number }>(
      'SELECT points FROM plugin_loyalty_points WHERE subscriber_id = $1',
      [sub.id]
    );
    expect(Number(r.rows[0].points)).toBe(5);
  });
});
