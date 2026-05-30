import { pool, query } from './pool.js';
import { createPlan } from '../domains/plans/service.js';
import { createSubscriber } from '../domains/subscribers/service.js';
import { createReseller } from '../domains/resellers/service.js';
import { credit, getOrCreateWallet } from '../domains/wallet/service.js';
import { createUser } from '../domains/auth/service.js';

async function seed() {
  console.log('Seeding demo data...');

  // Default admin login (change the password in production).
  const haveAdmin = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE username = 'admin'`);
  if (haveAdmin.rows[0].n === 0) {
    await createUser({ username: 'admin', password: 'admin123', role: 'admin' });
    console.log("  admin user created (username: admin / password: admin123)");
  }

  // Kenya VAT 16%
  await query(
    `INSERT INTO tax_rules (region, name, rate_bps, active)
     VALUES ('KE', 'VAT', 1600, TRUE)
     ON CONFLICT (region) WHERE active DO NOTHING`
  );

  const existing = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM plans');
  if (existing.rows[0].n > 0) {
    console.log('Plans already present — skipping demo inserts.');
    await pool.end();
    return;
  }

  // Plans (KES — prices in cents)
  const hotspot = await createPlan({ name: 'Hotspot 1-Day 5GB', type: 'hotspot', price_cents: 5000, validity_days: 1, data_cap_mb: 5120, speed_down_kbps: 5000, speed_up_kbps: 2000 });
  const home10 = await createPlan({ name: 'Home Fibre 10Mbps', type: 'postpaid', price_cents: 250000, billing_cycle: 'monthly', validity_days: 30, speed_down_kbps: 10000, speed_up_kbps: 10000 });
  const home20 = await createPlan({ name: 'Home Fibre 20Mbps', type: 'postpaid', price_cents: 350000, billing_cycle: 'monthly', validity_days: 30, speed_down_kbps: 20000, speed_up_kbps: 20000 });
  const prepaidWeek = await createPlan({ name: 'Prepaid Weekly 20GB', type: 'prepaid', price_cents: 80000, validity_days: 7, data_cap_mb: 20480, speed_down_kbps: 8000, speed_up_kbps: 4000, fup_threshold_pct: 80 });

  // Reseller with starting balance
  const reseller = await createReseller({ name: 'Westlands Cyber', phone: '254700111222', commission_bps: 1200 });
  const rw = await getOrCreateWallet('reseller', reseller.id);
  await credit(rw.id, 5_000_00, 'Initial float'); // KES 5,000

  // Subscribers
  const alice = await createSubscriber({ full_name: 'Alice Wanjiru', phone: '254712000001', type: 'hotspot' });
  const bob = await createSubscriber({ full_name: 'Bob Otieno', phone: '254712000002', type: 'pppoe', pppoe_username: 'bob.otieno' });

  // Give Alice some wallet balance for prepaid demos
  const aw = await getOrCreateWallet('subscriber', alice.id);
  await credit(aw.id, 1_000_00, 'Promo credit');

  console.log('Seed complete:');
  console.table({
    plans: [hotspot.name, home10.name, home20.name, prepaidWeek.name].length,
    reseller: reseller.name,
    subscribers: [alice.full_name, bob.full_name].length,
  });
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
