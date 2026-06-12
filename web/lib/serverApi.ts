import { cookies, headers } from 'next/headers';
import { api } from './api';

/**
 * API call from a Server Component. A server-side fetch has no browser context,
 * so we forward two things explicitly:
 *  - the logged-in JWT (from the cookie set at login) so protected reads work
 *    when AUTH_ENABLED=true;
 *  - the tenant's hostname as X-Forwarded-Host so the API's Host→tenant
 *    middleware routes the SSR read to the right tenant database (the API
 *    trusts X-Forwarded-* from loopback only).
 *
 * getBase() already points server-side fetches at the LOCAL API (127.0.0.1),
 * because the VPS can't reach its own public hostname.
 */
export function serverApi<T = any>(path: string): Promise<T> {
  const token = cookies().get('jtm_token')?.value;
  const host = headers().get('host');
  return api<T>(path, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(host ? { 'X-Forwarded-Host': host } : {}),
    },
  });
}
