'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { getToken, setToken, api } from '@/lib/api';

// Pages that never require an operator login.
const PUBLIC = ['/login', '/register', '/hotspot', '/portal', '/renew', '/technician'];

/**
 * Client-side gate. On a protected route with no/invalid token it bounces to
 * /login. Authenticated users render immediately (optimistic) while the token
 * is validated in the background; a 401 there clears it and redirects.
 *
 * Also enforces tenant suspension: if this tenant has been suspended by the
 * platform operator, the operator dashboard is replaced with a billing notice
 * (customer-facing captive-portal routes stay public and keep working).
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const [allowed, setAllowed] = useState(isPublic || (typeof window !== 'undefined' && !!getToken()));
  const [suspended, setSuspended] = useState<{ name: string | null } | null>(null);

  useEffect(() => {
    // Suspension applies to the whole operator app, not the public portal.
    if (!isPublic) {
      api<{ status: string; name: string | null }>('/tenants/status')
        .then((s) => { if (s.status === 'suspended') setSuspended({ name: s.name }); })
        .catch(() => {});
    }
    if (isPublic) { setAllowed(true); return; }
    if (!getToken()) { router.replace('/login'); return; }
    setAllowed(true);
    api('/auth/me').catch(() => { setToken(null); router.replace('/login'); });
  }, [pathname, isPublic, router]);

  if (suspended) {
    return (
      <div className="container" style={{ maxWidth: 560, paddingTop: 40 }}>
        <h1>Account suspended</h1>
        <div className="card">
          <p><strong>{suspended.name ?? 'This workspace'}</strong> has been suspended by the platform operator, pending payment of your platform invoice.</p>
          <p className="sub" style={{ marginTop: 10 }}>Your customers' hotspot service is unaffected. Settle your HubNet account to restore the dashboard. Contact the platform operator if you believe this is an error.</p>
        </div>
      </div>
    );
  }

  if (!isPublic && !allowed) {
    return <div style={{ padding: 40, color: 'var(--muted)' }}>Redirecting to sign in…</div>;
  }
  return <>{children}</>;
}
