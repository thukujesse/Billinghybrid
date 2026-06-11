import { pool } from './pool.js';
import { applyMigrations } from './runMigrations.js';

async function run() {
  const count = await applyMigrations(pool, (m) => process.stdout.write(m.endsWith(' ') ? m : m + '\n'));
  console.log(count ? `Applied ${count} migration(s).` : 'Already up to date.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
