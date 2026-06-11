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
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'));
  const [allowed, setAllowed] = useState(isPublic || (typeof window !== 'undefined' && !!getToken()));

  useEffect(() => {
    if (isPublic) { setAllowed(true); return; }
    if (!getToken()) { router.replace('/login'); return; }
    setAllowed(true);
    api('/auth/me').catch(() => { setToken(null); router.replace('/login'); });
  }, [pathname, isPublic, router]);

  if (!isPublic && !allowed) {
    return <div style={{ padding: 40, color: 'var(--muted)' }}>Redirecting to sign in…</div>;
  }
  return <>{children}</>;
}
