import { withTransaction } from '../../db/pool.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

export interface HotspotGrant {
  /** Username to pass to MikroTik hotspot login (typically = voucher code). */
  username: string;
  /** Password to pass to MikroTik hotspot login (we accept any non-empty). */
  password: string;
  /** Session-Timeout reply attribute, in seconds. */
  validitySeconds: number;
  /** Rate limit string (e.g. "5M/5M") for the customer's link. */
  rateLimit: string | null;
  /** Plan name for friendly UI display. */
  planName: string;
}

interface PlanRow {
  id: string;
  name: string;
  validity_days: number;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
}

/**
 * Voucher-based hotspot grant. Atomically:
 *   1. Mark the voucher used
 *   2. Insert radcheck row keyed by the voucher code (= the username
 *      MikroTik will send in its hotspot Access-Request)
 *   3. Insert radreply rows for Session-Timeout + Mikrotik-Rate-Limit
 * Returns the credentials the portal page will pass back to MikroTik.
 */
export async function redeemVoucher(input: {
  code: string;
  mac?: string;
}): Promise<HotspotGrant> {
  const code = input.code.trim().toUpperCase();
  if (!code) throw badRequest('voucher code required');

  return withTransaction(async (c) => {
    // Lock voucher row + load plan in one go.
    const r = await c.query<{
      voucher_id: string;
      status: string;
      voucher_expires: string | null;
      plan_id: string;
      plan_name: string;
      validity_days: number;
      speed_down_kbps: number | null;
      speed_up_kbps: number | null;
    }>(
      `SELECT v.id AS voucher_id, v.status, v.expires_at AS voucher_expires,
              p.id AS plan_id, p.name AS plan_name, p.validity_days,
              p.speed_down_kbps, p.speed_up_kbps
         FROM vouchers v
         JOIN plans p ON p.id = v.plan_id
        WHERE v.code = $1 FOR UPDATE OF v`,
      [code]
    );
    const voucher = r.rows[0];
    if (!voucher) throw notFound('voucher');
    if (voucher.status !== 'unused') throw conflict(`voucher is ${voucher.status}`);
    if (voucher.voucher_expires && new Date(voucher.voucher_expires) < new Date()) {
      await c.query(`UPDATE vouchers SET status='expired' WHERE id=$1`, [voucher.voucher_id]);
      throw conflict('voucher has expired');
    }

    await c.query(
      `UPDATE vouchers SET status='used', used_at=now() WHERE id=$1`,
      [voucher.voucher_id]
    );

    // Compute reply attributes from the plan.
    const validitySeconds = Math.max(60, voucher.validity_days * 86400);
    const rateLimit = voucher.speed_down_kbps && voucher.speed_up_kbps
      ? `${voucher.speed_up_kbps}k/${voucher.speed_down_kbps}k`
      : null;

    // Insert into FreeRADIUS tables. Username = voucher code; password is the
    // same (hotspot auth doesn't really care, MAC binding via Calling-Station
    // is the real identity in MikroTik's Hotspot flow).
    await c.query(`DELETE FROM radcheck WHERE username=$1`, [code]);
    await c.query(`DELETE FROM radreply WHERE username=$1`, [code]);
    await c.query(
      `INSERT INTO radcheck (username, attribute, op, value)
       VALUES ($1, 'Cleartext-Password', ':=', $1)`,
      [code]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Session-Timeout', ':=', $2)`,
      [code, String(validitySeconds)]
    );
    await c.query(
      `INSERT INTO radreply (username, attribute, op, value)
       VALUES ($1, 'Idle-Timeout', ':=', '600')`,
      [code]
    );
    if (rateLimit) {
      await c.query(
        `INSERT INTO radreply (username, attribute, op, value)
         VALUES ($1, 'Mikrotik-Rate-Limit', '=', $2)`,
        [code, rateLimit]
      );
    }

    return {
      username: code,
      password: code,
      validitySeconds,
      rateLimit,
      planName: voucher.plan_name,
    };
  });
}
