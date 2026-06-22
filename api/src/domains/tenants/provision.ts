import { pool, poolForConnString, runWithTenant, query } from '../../db/pool.js';
import { applyMigrations } from '../../db/runMigrations.js';
import { config } from '../../config.js';
import { badRequest, conflict, notFound, AppError } from '../../lib/errors.js';
import { createUser } from '../auth/service.js';
import {
  createTenantRow, setTenantStatus, recordTenantError, markTenantFailed, getTenantById,
  addDomain, slugTaken, type Tenant,
} from './service.js';

// Reserved subdomains that must never be minted as a tenant slug — they collide
// with the platform's own hosts/roles.
const RESERVED = new Set([
  'default', 'www', 'api', 'app', 'admin', 'portal', 'billing', 'demo',
  'vpn', 'mail', 'ns', 'ns1', 'ns2', 'status', 'staging', 'test', 'postgres',
]);

/** Validate + normalize a tenant slug: DNS-label-safe and a legal Postgres db name. */
export function normalizeSlug(raw: string): string {
  const slug = (raw || '').toLowerCase().trim();
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug)) {
    throw badRequest('slug must be 3–32 chars: lowercase letters, digits and hyphens, starting with a letter');
  }
  if (slug.includes('--')) throw badRequest('slug cannot contain consecutive hyphens');
  if (RESERVED.has(slug)) throw badRequest(`"${slug}" is reserved — choose another`);
  return slug;
}

/** Swap the database name in a DSN, preserving host/port/user/password/params. */
function withDatabase(dsn: string, dbName: string): string {
  const u = new URL(dsn);
  u.pathname = '/' + dbName;
  return u.toString();
}

/** The Postgres database name behind a tenant's stored DSN — the single source
 *  of truth for which DB to create/migrate. Never recompute it from the slug: a
 *  subdomain rename changes the slug but deliberately NOT the DSN, so a
 *  slug-derived name would desync and create a stray orphan database. */
function dbNameFromDsn(dsn: string): string {
  return new URL(dsn).pathname.replace(/^\//, '');
}

/**
 * Serialize the whole create→migrate→seed→activate sequence for one tenant.
 * CREATE DATABASE can't run in a transaction, so we hold a SESSION-level
 * advisory lock on a dedicated control-DB connection (not a transactional one).
 * A second overlapping attempt — e.g. an operator hitting "Retry" while signup
 * is still provisioning, or two operators retrying at once — fails fast with 409
 * instead of racing CREATE DATABASE / concurrent applyMigrations / the admin
 * seed. The lock auto-releases if the holding connection dies, so a crashed
 * provision never wedges recovery.
 */
async function withProvisionLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('tenant_provision'), hashtext($1)) AS locked`,
      [tenantId]
    );
    if (!r.rows[0]?.locked) {
      throw new AppError(409, 'provision_busy', 'provisioning is already in progress for this tenant — try again in a moment');
    }
    try {
      return await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('tenant_provision'), hashtext($1))`, [tenantId]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Grant the welcome SMS starter credit exactly once (idempotent on the
 *  'welcome' ledger row) so a freshly provisioned OR recovered tenant isn't
 *  stuck at zero balance with dead OTP. Best-effort — never blocks provisioning. */
async function grantWelcomeCreditOnce(tenantId: string): Promise<void> {
  if (config.control.sms.freeStarterCents <= 0) return;
  const sms = await import('../platform/smsBilling.js');
  if (await sms.hasLedgerReason(tenantId, 'welcome').catch(() => false)) return;
  await sms.credit(tenantId, config.control.sms.freeStarterCents, 'welcome').catch(() => {});
}

export interface ProvisionInput {
  name: string;            // ISP display name
  slug: string;
  adminUsername: string;
  adminPassword: string;
  contactPhone?: string;
  contactEmail?: string;
}

export interface ProvisionResult {
  tenant: Tenant;
  host: string;
  loginUrl: string;
}

/**
 * Provision a brand-new, fully isolated tenant:
 *   1. reserve the slug (tenant row, status=provisioning)
 *   2. CREATE DATABASE on the same Postgres instance
 *   3. run all migrations into it
 *   4. seed the ISP's first admin INTO that DB
 *   5. map <slug>.<baseDomain> → tenant and flip status=active
 *
 * Runs synchronously (CREATE DATABASE + migrations take a few seconds). On any
 * failure after the row is created, the tenant is marked 'failed' and the error
 * is surfaced — the half-built DB is left for an operator to inspect/drop.
 */
export async function provisionTenant(input: ProvisionInput): Promise<ProvisionResult> {
  const slug = normalizeSlug(input.slug);
  if (!input.name?.trim()) throw badRequest('ISP name is required');
  if ((input.adminUsername ?? '').length < 3) throw badRequest('admin username must be at least 3 characters');
  if ((input.adminPassword ?? '').length < 6) throw badRequest('admin password must be at least 6 characters');
  if (await slugTaken(slug)) throw conflict(`the subdomain "${slug}" is already taken`);

  const dbName = `jtm_t_${slug.replace(/-/g, '_')}`;
  const tenantDsn = withDatabase(config.control.adminDatabaseUrl, dbName);

  // Reserve the slug first so two concurrent signups can't race the same name
  // (UNIQUE(slug) makes the second INSERT fail).
  let tenant: Tenant;
  try {
    tenant = await createTenantRow({
      slug, name: input.name.trim(), db_conn_string: tenantDsn, status: 'provisioning',
      contact_phone: input.contactPhone ?? null, contact_email: input.contactEmail ?? null,
    });
  } catch (err: any) {
    if (err?.code === '23505') throw conflict(`the subdomain "${slug}" is already taken`);
    throw err;
  }

  // Serialize the build so a concurrent Retry can't race it (the lock-busy 409 is
  // thrown before the inner try, so it never marks the brand-new tenant failed).
  return withProvisionLock(tenant.id, async () => {
    try {
      // CREATE DATABASE can't run inside a transaction; pool.query is autocommit.
      // dbName is derived from a validated slug ([a-z0-9_]), safe to interpolate.
      const maint = poolForConnString(withDatabase(config.control.adminDatabaseUrl, 'postgres'));
      const exists = await maint.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      if ((exists.rowCount ?? 0) > 0) {
        throw new AppError(500, 'provision_error', `database ${dbName} already exists — clean it up before retrying`);
      }
      await maint.query(`CREATE DATABASE "${dbName}"`);

      const tenantPool = poolForConnString(tenantDsn);
      await applyMigrations(tenantPool);

      // Seed the first admin INTO the new tenant's DB by binding its pool.
      await runWithTenant({ tenantId: slug, pool: tenantPool }, async () => {
        await createUser({ username: input.adminUsername, password: input.adminPassword, role: 'admin' });
      });

      const host = `${slug}.${config.control.baseDomain}`;
      await addDomain(host, tenant.id, true);
      await setTenantStatus(tenant.id, 'active');
      await grantWelcomeCreditOnce(tenant.id);

      return { tenant: { ...tenant, status: 'active' }, host, loginUrl: `https://${host}/login` };
    } catch (err) {
      const msg = (err as Error).message;
      await markTenantFailed(tenant.id, msg).catch(() => {});
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'provision_error', `failed to provision tenant: ${msg}`);
    }
  });
}

/**
 * Resume a half-built tenant after a failed provision — the recovery path behind
 * the platform console's "Retry". Safe because applyMigrations is idempotent
 * (each step is transactional + tracked in schema_migrations), so it simply
 * picks up wherever the first attempt died: ensure the DB exists, finish the
 * migrations, seed the first admin ONLY if none exists yet, map the host, and
 * flip to active. Never drops anything; never touches an active or the platform
 * tenant. If the original attempt died before the admin was created, the
 * operator must supply admin credentials to finish (the signup password was
 * never persisted) — otherwise the existing admin is left untouched.
 */
export async function resumeProvision(
  tenantId: string,
  adminUsername?: string,
  adminPassword?: string,
): Promise<ProvisionResult> {
  // Hold the provisioning lock for the whole recovery. Re-read the tenant INSIDE
  // the lock so that if a still-running first provision just won the race, we see
  // the now-'active' status and bail cleanly instead of racing/clobbering it.
  return withProvisionLock(tenantId, async () => {
    const t = await getTenantById(tenantId);
    if (!t) throw notFound('tenant');
    if (t.slug === config.control.platformTenant) throw badRequest('the platform tenant cannot be provisioned');
    if (t.status !== 'failed' && t.status !== 'provisioning') {
      throw badRequest(`only a failed or stuck tenant can be retried (this one is "${t.status}")`);
    }
    if (!t.db_conn_string) throw badRequest('this tenant has no isolated database to provision');

    // Single source of truth — the DB behind the stored DSN (a subdomain rename
    // changes the slug but not the DSN, so a slug-derived name would diverge).
    const dbName = dbNameFromDsn(t.db_conn_string);
    await setTenantStatus(t.id, 'provisioning');
    await recordTenantError(t.id, null).catch(() => {});

    try {
      // Create the DB only if a prior attempt didn't get that far — reuse it
      // otherwise (the resume case); migrations below are idempotent.
      const maint = poolForConnString(withDatabase(config.control.adminDatabaseUrl, 'postgres'));
      const exists = await maint.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      if ((exists.rowCount ?? 0) === 0) {
        await maint.query(`CREATE DATABASE "${dbName}"`);
      }

      const tenantPool = poolForConnString(t.db_conn_string);
      await applyMigrations(tenantPool);

      // Seed the first admin only if no ADMIN exists yet (a non-admin row must
      // not let the tenant go active with no usable login).
      const hasAdmin = await runWithTenant({ tenantId: t.slug, pool: tenantPool }, async () => {
        const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`);
        return (r.rows[0]?.n ?? 0) > 0;
      });
      if (!hasAdmin) {
        if ((adminUsername ?? '').length < 3 || (adminPassword ?? '').length < 6) {
          throw badRequest('this workspace has no admin yet — provide an admin username (3+) and password (6+) to finish setup');
        }
        await runWithTenant({ tenantId: t.slug, pool: tenantPool }, async () => {
          await createUser({ username: adminUsername!, password: adminPassword!, role: 'admin' });
        });
      }

      const host = `${t.slug}.${config.control.baseDomain}`;
      await addDomain(host, t.id, true);
      await setTenantStatus(t.id, 'active');
      await grantWelcomeCreditOnce(t.id);
      return { tenant: { ...t, status: 'active' }, host, loginUrl: `https://${host}/login` };
    } catch (err) {
      const msg = (err as Error).message;
      await markTenantFailed(t.id, msg).catch(() => {});
      if (err instanceof AppError) throw err;
      throw new AppError(500, 'provision_error', `retry failed: ${msg}`);
    }
  });
}
