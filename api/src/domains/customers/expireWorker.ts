/**
 * Auto-expire worker for PPPoE services.
 *
 * Sweeps services whose expiry_date has passed and flips them to
 * status='expired'. setServiceStatus() inside expireDueServices()
 * handles the side-effects: re-syncs RADIUS reply attributes and pushes
 * the customer's framed-IP into jtm-expired on every managed MikroTik
 * so HTTP gets captive-redirected to /renew.
 *
 * Runs hourly by default — granularity finer than that costs more queries
 * than it's worth (a customer who pays at HH:55 still has up to ~5 min
 * buffer before being kicked, which is fine; the M-Pesa-callback path
 * restores them immediately when their payment lands).
 *
 * Disabled when WORKER_ENABLED=false (shared flag with the payment
 * worker — replicas that don't run jobs shouldn't run this either).
 */
import { config } from '../../config.js';
import { expireDueServices, notifyExpiringSoon } from './service.js';
import { autoRenewDue } from './wallet.js';
import { lowBalanceSweep } from './notifications.js';

export function startExpireWorker(intervalMs = 60 * 60 * 1000): () => Promise<void> {
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const run = async () => {
    if (stopping || inFlight) return;
    inFlight = (async () => {
      try {
        // Order: wallet auto-renew FIRST (silent, no SMS, customer stays
        // online), then warning sweep for customers without enough wallet
        // balance, then expire sweep for the past-due. The auto-renew
        // step shortens the warning list — customers who got auto-renewed
        // are no longer 'expiring soon' and don't get an SMS.
        try {
          const renewed = await autoRenewDue(24);
          if (renewed.length > 0) {
            console.log(JSON.stringify({
              level: 'info', msg: 'auto_renew_sweep',
              count: renewed.length,
              total_kes: renewed.reduce((a, b) => a + b.amount_cents, 0) / 100,
            }));
          }
        } catch (err) {
          console.error('[expire-worker] auto-renew sweep failed:', (err as Error).message);
        }
        // Low-balance sweep — SMS customers whose auto-renew is on but
        // wallet can't cover the next renewal in 7 days. Runs AFTER
        // autoRenewDue so customers who just got renewed don't get a
        // pointless "your wallet is low" message in the same tick.
        try {
          const { warned } = await lowBalanceSweep(7 * 24);
          if (warned > 0) {
            console.log(JSON.stringify({ level: 'info', msg: 'low_balance_sweep', count: warned }));
          }
        } catch (err) {
          console.error('[expire-worker] low-balance sweep failed:', (err as Error).message);
        }
        try {
          const { warned } = await notifyExpiringSoon(24);
          if (warned > 0) {
            console.log(JSON.stringify({ level: 'info', msg: 'expiry_warning_sweep', count: warned }));
          }
        } catch (err) {
          console.error('[expire-worker] warning sweep failed:', (err as Error).message);
        }
        const expired = await expireDueServices();
        if (expired.length > 0) {
          console.log(JSON.stringify({
            level: 'info', msg: 'auto_expire_sweep',
            count: expired.length,
            services: expired.map((s) => ({ id: s.id, username: s.username })),
          }));
        }
      } catch (err) {
        console.error('[expire-worker] sweep failed:', (err as Error).message);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // Fire once on startup so a long-down service catches up quickly,
  // then settle into the interval cadence.
  setTimeout(run, 30_000).unref();
  const tick = setInterval(run, intervalMs);
  tick.unref();

  return async () => {
    stopping = true;
    clearInterval(tick);
    if (inFlight) await inFlight;
  };
}

// Read interval from env so ops can tune without a redeploy.
export const expireWorkerIntervalMs = (() => {
  const env = process.env.EXPIRE_WORKER_INTERVAL_MS;
  if (!env) return 60 * 60 * 1000;
  const n = Number(env);
  return Number.isFinite(n) && n >= 60_000 ? n : 60 * 60 * 1000;
})();

export const expireWorkerEnabled = config.paymentQueue.enabled;