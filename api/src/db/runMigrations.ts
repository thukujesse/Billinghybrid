import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

/**
 * Apply every pending .sql migration to `target` in filename order, each in its
 * own transaction, tracking applied files in schema_migrations. Idempotent.
 *
 * Shared by the `migrate` CLI (against the control DB) and the tenant
 * provisioner (against a freshly-created tenant DB) so both schemas never drift.
 *
 * `log` defaults to a no-op so provisioning stays quiet; the CLI passes through
 * to stdout.
 */
export async function applyMigrations(
  target: pg.Pool,
  log: (msg: string) => void = () => {}
): Promise<number> {
  await target.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await target.query<{ filename: string }>('SELECT filename FROM schema_migrations'))
      .rows.map((r) => r.filename)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    log(`Applying ${file} ... `);
    const client = await target.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log('done');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      log('FAILED');
      throw err;
    } finally {
      client.release();
    }
  }
  return count;
}
