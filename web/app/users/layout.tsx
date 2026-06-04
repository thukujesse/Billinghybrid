'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const TABS = [
  { href: '/users/hotspot',    label: 'Hotspot',    blurb: 'M-Pesa walk-ins'   },
  { href: '/customers',        label: 'Customers',  blurb: 'PPPoE accounts'    },
  { href: '/subscribers',      label: 'Subscribers', blurb: 'SMS / OTP logins' },
];

export default function UsersLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  return (
    <div className="container">
      <div className="subnav" style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--border, #e2e8f0)', marginBottom: 20, marginTop: 4 }}>
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <Link
              key={t.href}
              href={t.href}
              style={{
                padding: '10px 14px',
                fontSize: 14,
                fontWeight: 600,
                color: active ? 'var(--brand, #2563eb)' : 'var(--muted, #64748b)',
                borderBottom: active ? '2px solid var(--brand, #2563eb)' : '2px solid transparent',
                marginBottom: -1,
                textDecoration: 'none',
              }}
            >
              {t.label}
              <span style={{ display: 'block', fontSize: 10, fontWeight: 400, color: 'var(--muted, #94a3b8)' }}>{t.blurb}</span>
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}