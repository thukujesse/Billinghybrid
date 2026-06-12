import { poolForConnString, runWithTenant } from '../../db/pool.js';
import { applyMigrations } from '../../db/runMigrations.js';
import { config } from '../../config.js';
import { badRequest, conflict, AppError } from '../../lib/errors.js';
import { createUser } from '../auth/service.js';
import {
  createTenantRow, setTenantStatus, addDomain, slugTaken, type Tenant,
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

    // Welcome SMS credit so OTP / notifications work out of the box on the
    // shared sender before the operator tops them up.
    if (config.control.sms.freeStarterCents > 0) {
      const { credit } = await import('../platform/smsBilling.js');
      await credit(tenant.id, config.control.sms.freeStarterCents, 'welcome').catch(() => {});
    }

    return { tenant: { ...tenant, status: 'active' }, host, loginUrl: `https://${host}/login` };
  } catch (err) {
    await setTenantStatus(tenant.id, 'failed').catch(() => {});
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'provision_error', `failed to provision tenant: ${(err as Error).message}`);
  }
}
