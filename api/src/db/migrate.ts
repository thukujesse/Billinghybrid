import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, 'migrations');

async function run() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await query<{ filename: string }>('SELECT filename FROM schema_migrations'))
      .rows.map((r) => r.filename)
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('done');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(count ? `Applied ${count} migration(s).` : 'Already up to date.');
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
