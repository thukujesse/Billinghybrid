import { query } from '../../db/pool.js';
import { getAdapter, type NetworkAction } from '../network/index.js';
import { routerForSubscriber } from '../routers/service.js';

/**
 * Provisioning Service — translates billing events into network actions.
 *
 * It resolves the subscriber's router and PPPoE identity, hands the action to
 * the configured NetworkAdapter (log by default, Mikrotik RouterOS when
 * NETWORK_DRIVER=mikrotik), and records the outcome to `provisioning_actions`
 * for audit. Swap the adapter — not this service — to integrate live gear.
 */
async function apply(
  subscriberId: string,
  action: NetworkAction,
  detail: Record<string, unknown> = {}
): Promise<void> {
  const adapter = getAdapter();

  // Resolve routing + identity context (best-effort).
  const [router, subRow] = await Promise.all([
    routerForSubscriber(subscriberId).catch(() => null),
    query<{ pppoe_username: string | null }>('SELECT pppoe_username FROM subscribers WHERE id = $1', [subscriberId]),
  ]);

  let status: 'applied' | 'failed' = 'applied';
  let note = '';
  try {
    const result = await adapter.apply(action, {
      subscriberId,
      pppoeUsername: subRow.rows[0]?.pppoe_username ?? null,
      router: router
        ? { id: router.id, name: router.name, host: router.host, api_port: router.api_port, type: router.type }
        : null,
      detail,
    });
    note = result.note;
    status = result.ok ? 'applied' : 'failed';
  } catch (err) {
    status = 'failed';
    note = err instanceof Error ? err.message : String(err);
  }

  await query(
    `INSERT INTO provisioning_actions (subscriber_id, action, status, detail)
     VALUES ($1, $2, $3, $4)`,
    [subscriberId, action, status, JSON.stringify({ ...detail, adapter: adapter.name, note })]
  );
}

export const provisioning = {
  activate: (id: string, detail?: Record<string, unknown>) => apply(id, 'activate', detail),
  suspend: (id: string, detail?: Record<string, unknown>) => apply(id, 'suspend', detail),
  restore: (id: string, detail?: Record<string, unknown>) => apply(id, 'restore', detail),
  throttle: (id: string, detail?: Record<string, unknown>) => apply(id, 'throttle', detail),
  unthrottle: (id: string, detail?: Record<string, unknown>) => apply(id, 'unthrottle', detail),
};
