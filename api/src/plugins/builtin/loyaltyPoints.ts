import type { Plugin } from '../types.js';
import { query } from '../../db/pool.js';

/**
 * Example event-hook plugin: award loyalty points whenever a payment is paid.
 * Points are tracked in a tiny table the plugin owns (created on register), so
 * it adds a feature with zero changes to core billing.
 */
export const loyaltyPointsPlugin: Plugin = {
  manifest: {
    id: 'loyalty-points',
    name: 'Loyalty Points',
    version: '1.0.0',
    description: 'Awards 1 point per KES 100 paid; exposes a balance endpoint.',
  },
  async register(ctx) {
    await query(`
      CREATE TABLE IF NOT EXISTS plugin_loyalty_points (
        subscriber_id UUID PRIMARY KEY,
        points        BIGINT NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    ctx.on('payment.paid', async (p) => {
      const subscriberId = p.subscriberId as string | undefined;
      const amount = Number(p.amount ?? 0); // cents
      if (!subscriberId || amount <= 0) return;
      const points = Math.floor(amount / 100 / 100); // 1 pt per KES 100
      if (points <= 0) return;
      await query(
        `INSERT INTO plugin_loyalty_points (subscriber_id, points)
         VALUES ($1, $2)
         ON CONFLICT (subscriber_id)
         DO UPDATE SET points = plugin_loyalty_points.points + EXCLUDED.points, updated_at = now()`,
        [subscriberId, points]
      );
      ctx.log(`awarded ${points} point(s) to ${subscriberId}`);
    });

    // GET /api/ext/loyalty-points/:subscriberId
    ctx.router.get('/:subscriberId', async (req, res) => {
      const r = await query<{ points: number }>(
        'SELECT points FROM plugin_loyalty_points WHERE subscriber_id = $1',
        [req.params.subscriberId]
      );
      res.json({ subscriber_id: req.params.subscriberId, points: Number(r.rows[0]?.points ?? 0) });
    });
  },
};
