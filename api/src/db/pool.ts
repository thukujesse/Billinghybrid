import pg from 'pg';
import { config } from '../config.js';

// Postgres returns BIGINT (OID 20) as string by default to avoid precision
// loss. All our money columns fit safely in a JS number (< 2^53), so parse
// them to numbers for ergonomic arithmetic in the service layer.
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export type Queryable = Pick<pg.PoolClient, 'query'> | pg.Pool;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool
): Promise<pg.QueryResult<T>> {
  return client.query<T>(text, params as any[]);
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on
 * any thrown error. Used wherever money moves (ledger, payments, vouchers).
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
