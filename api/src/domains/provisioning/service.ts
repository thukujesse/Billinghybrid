import { query } from '../../db/pool.js';

/**
 * Provisioning Service — translates billing events into network actions.
 *
 * In production this calls the Mikrotik RouterOS API (add/remove user, set
 * rate-limit, block IP) and FreeRADIUS (CoA / disconnect). Here we record the
 * intent to `provisioning_actions` so the rest of the system — and the admin
 * UI — can be built and tested end-to-end without live routers. Swap the body
 * of `apply()` for a real RouterOS adapter and everything upstream is unchanged.
 */

type Action = 'activate' | 'suspend' | 'restore' | 'throttle' | 'unthrottle';

async function apply(
  subscriberId: string,
  action: Action,
  detail: Record<string, unknown> = {}
): Promise<void> {
  // --- real adapter would go here ---
  // e.g. routerOS.setRateLimit(user, ...) / radius.disconnect(user)
  await query(
    `INSERT INTO provisioning_actions (subscriber_id, action, status, detail)
     VALUES ($1, $2, 'applied', $3)`,
    [subscriberId, action, JSON.stringify(detail)]
  );
  console.log(`[provisioning] ${action} -> subscriber ${subscriberId}`);
}

export const provisioning = {
  activate: (id: string, detail?: Record<string, unknown>) => apply(id, 'activate', detail),
  suspend: (id: string, detail?: Record<string, unknown>) => apply(id, 'suspend', detail),
  restore: (id: string, detail?: Record<string, unknown>) => apply(id, 'restore', detail),
  throttle: (id: string, detail?: Record<string, unknown>) => apply(id, 'throttle', detail),
  unthrottle: (id: string, detail?: Record<string, unknown>) => apply(id, 'unthrottle', detail),
};
