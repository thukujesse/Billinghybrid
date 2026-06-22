import { pathToFileURL } from 'node:url';
import { pool, poolForConnString } from './pool.js';
import { applyMigrations } from './runMigrations.js';

/**
 * Apply every pending migration to each ISOLATED tenant DB (those with their own
 * db_conn_string). The `migrate` CLI only touches the control/default DB; this
 * brings already-provisioned tenants up to the same schema. Idempotent — tracked
 * per-DB in schema_migrations, so re-running is safe. Per-tenant failures are
 * isolated (logged, never abort the others) so one bad tenant can't block boot.
 *
 * Exported so the API can run it automatically on startup (see server.ts) — the
 * standalone CLI guard below only fires when this file is executed directly.
 */
export async function migrateAllTenants(
  log: (msg: string) => void = (m) => process.stdout.write(m)
): Promise<void> {
  const tenants = await pool.query<{ slug: string; db_conn_string: string }>(
    'SELECT slug, db_conn_string FROM tenant WHERE db_conn_string IS NOT NULL ORDER BY slug'
  );
  for (const t of tenants.rows) {
    try {
      const n = await applyMigrations(poolForConnString(t.db_conn_string));
      log(`tenant ${t.slug}: ${n ? `applied ${n}` : 'up to date'}\n`);
    } catch (e) {
      log(`tenant ${t.slug}: FAILED — ${(e as Error).message}\n`);
    }
  }
}

// CLI entry: `tsx src/db/migrateTenants.ts`. Guarded so importing this module
// (e.g. from server.ts) does NOT trigger a migrate + pool.end().
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateAllTenants()
    .then(() => pool.end())
    .catch((err) => { console.error(err); process.exit(1); });
}
