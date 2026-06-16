import { pool, poolForConnString } from './pool.js';
import { applyMigrations } from './runMigrations.js';

/**
 * Apply every pending migration to each ISOLATED tenant DB (those with their own
 * db_conn_string). The `migrate` CLI only touches the control/default DB; this
 * brings already-provisioned tenants up to the same schema. Idempotent — tracked
 * per-DB in schema_migrations, so re-running is safe.
 */
async function run() {
  const tenants = await pool.query<{ slug: string; db_conn_string: string }>(
    'SELECT slug, db_conn_string FROM tenant WHERE db_conn_string IS NOT NULL ORDER BY slug'
  );
  for (const t of tenants.rows) {
    process.stdout.write(`Migrating tenant ${t.slug} ... `);
    try {
      const tp = poolForConnString(t.db_conn_string);
      const n = await applyMigrations(tp);
      console.log(n ? `applied ${n}` : 'already up to date');
    } catch (e) {
      console.log('FAILED');
      console.error(`  ${t.slug}:`, (e as Error).message);
    }
  }
  await pool.end();
}

run().catch((err) => { console.error(err); process.exit(1); });
