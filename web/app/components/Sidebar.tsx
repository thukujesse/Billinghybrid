'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getToken, setToken } from '@/lib/api';

// Hidden on the captive portal + the standalone login page.
const CUSTOMER_PATHS = ['/hotspot', '/renew', '/portal', '/login'];

const BRAND = 'HUBNETWORKS';

type Item = { href: string; label: string };
type Group = { key: string; label: string; ico: string; items: Item[] };
interface NavCounts { subscribers: number; live_sessions: number; unmatched_payments: number; open_alerts: number }

// Flat, always-visible sections (matches the overview design). Every route the
// app exposes is grouped here — nothing is hidden behind an accordion. Labels
// follow the product vocabulary; hrefs are the real, existing routes.
const GROUPS: Group[] = [
  {
    key: 'customers', label: 'Customers', ico: '👥', items: [
      { href: '/customers', label: 'Subscribers' },
      { href: '/leads', label: 'Leads' },
      { href: '/users/hotspot', label: 'Hotspot users' },
    ],
  },
  {
    key: 'network', label: 'Network', ico: '📶', items: [
      { href: '/sessions', label: 'Live sessions' },
      { href: '/plans', label: 'Plans' },
      { href: '/routers', label: 'Routers' },
      { href: '/network', label: 'Overview' },
      { href: '/network/twin', label: 'Live map' },
      { href: '/payment-events', label: 'Payment queue' },
      { href: '/plugins', label: 'Plugins' },
    ],
  },
  {
    key: 'finance', label: 'Finance', ico: '💳', items: [
      { href: '/invoices', label: 'Invoices' },
      { href: '/payments', label: 'Payments' },
      { href: '/reconciliation', label: 'Reconciliation' },
      { href: '/vouchers', label: 'Vouchers' },
      { href: '/resellers', label: 'Resellers' },
    ],
  },
  {
    key: 'outreach', label: 'Outreach', ico: '📣', items: [
      { href: '/alerts', label: 'Alerts' },
      { href: '/messages', label: 'Message templates' },
      { href: '/ads', label: 'Ads' },
      { href: '/settings#sms', label: 'SMS / Notifications' },
    ],
  },
  {
    key: 'insights', label: 'Insights', ico: '📊', items: [
      { href: '/reports', label: 'Analytics' },
      { href: '/audit', label: 'Audit log' },
    ],
  },
  {
    key: 'platform', label: 'Platform', ico: '🏢', items: [
      { href: '/platform', label: 'Tenants' },
      { href: '/platform/billing', label: 'Billing & collections' },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  const path = href.split('#')[0];
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(path + '/');
}

function setHtmlSidebar(state: 'shown' | 'hidden') {
  document.documentElement.setAttribute('data-sidebar', state);
}

export function Sidebar() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const isCustomer = CUSTOMER_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [hidden, setHidden] = useState(false);
  const [me, setMe] = useState<{ username?: string; role?: string } | null>(null);
  const [counts, setCounts] = useState<NavCounts | null>(null);

  // Who's signed in (drives the footer) + live badge counts. Quietly null if not
  // authenticated. Refreshes on navigation so badges reflect recent actions.
  useEffect(() => {
    if (typeof window !== 'undefined' && getToken()) {
      api<{ username?: string; role?: string }>('/auth/me').then(setMe).catch(() => setMe(null));
      api<NavCounts>('/dashboard/nav-counts').then(setCounts).catch(() => { /* endpoint absent before deploy */ });
    } else {
      setMe(null); setCounts(null);
    }
  }, [pathname]);

  // Badge for a nav item: neutral counts (subscribers, live sessions) and
  // attention counts (unclaimed payments, open alerts — only shown when > 0).
  const badgeFor = (href: string): { v: number; attn: boolean } | null => {
    if (!counts) return null;
    if (href === '/customers' && counts.subscribers > 0) return { v: counts.subscribers, attn: false };
    if (href === '/sessions' && counts.live_sessions > 0) return { v: counts.live_sessions, attn: false };
    if (href === '/reconciliation' && counts.unmatched_payments > 0) return { v: counts.unmatched_payments, attn: true };
    if (href === '/alerts' && counts.open_alerts > 0) return { v: counts.open_alerts, attn: true };
    return null;
  };
  const logout = () => { setToken(null); setMe(null); router.replace('/login'); };

  // Sync local state with what the pre-paint bootstrap already applied.
  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') setTheme(t);
    const s = document.documentElement.getAttribute('data-sidebar');
    setHidden(s === 'hidden');
  }, []);

  // Customer routes: no sidebar, and collapse the shell so content isn't pushed.
  useEffect(() => {
    if (isCustomer) setHtmlSidebar('hidden');
  }, [isCustomer]);

  if (isCustomer) return null;

  const setSidebar = (next: boolean) => {
    setHidden(next);
    setHtmlSidebar(next ? 'hidden' : 'shown');
    try { localStorage.setItem('jtm-sidebar', next ? 'hidden' : 'shown'); } catch { /* ignore */ }
  };

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('jtm-theme', next); } catch { /* ignore */ }
  };

  // On mobile, following a link should close the overlay.
  const onNavigate = () => {
    if (typeof window !== 'undefined' && window.innerWidth <= 860) setSidebar(true);
  };

  return (
    <>
      <button
        className="nav-icon-btn sidebar-reopen"
        aria-label="Open menu"
        onClick={() => setSidebar(false)}
      >☰</button>

      <div className="sidebar-backdrop" onClick={() => setSidebar(true)} />

      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">{BRAND}</span>
          <button
            className="nav-icon-btn sidebar-collapse"
            aria-label="Hide menu"
            title="Hide menu"
            onClick={() => setSidebar(true)}
          >«</button>
        </div>

        <nav className="sidebar-nav">
          <a
            href="/"
            className={`side-link${isActive(pathname, '/') ? ' active' : ''}`}
            onClick={onNavigate}
          >
            <span className="ico">⌂</span> Overview
          </a>

          {GROUPS.map((g) => (
            <div key={g.key} style={{ marginTop: 14 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase',
                color: 'var(--muted)', padding: '0 12px 6px', display: 'flex', alignItems: 'center', gap: 7,
              }}>
                <span aria-hidden style={{ fontSize: 12 }}>{g.ico}</span>{g.label}
              </div>
              {g.items.map((i) => {
                const b = badgeFor(i.href);
                return (
                  <a
                    key={i.href}
                    href={i.href}
                    className={`side-link${isActive(pathname, i.href) ? ' active' : ''}`}
                    onClick={onNavigate}
                    style={{ display: 'flex', alignItems: 'center' }}
                  >
                    {i.label}
                    {b && (
                      <span style={{
                        marginLeft: 'auto', fontSize: 11, fontWeight: 700, lineHeight: 1,
                        padding: '2px 7px', borderRadius: 999,
                        color: b.attn ? '#dc2626' : 'var(--muted)',
                        background: b.attn ? 'var(--red-weak, rgba(220,38,38,0.12))' : 'var(--card-2, rgba(0,0,0,0.06))',
                      }}>{b.v > 999 ? '999+' : b.v}</span>
                    )}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a
              href="/settings"
              className={`side-link${isActive(pathname, '/settings') ? ' active' : ''}`}
              onClick={onNavigate}
            ><span className="ico">⚙</span> Settings</a>
            <button
              className="nav-icon-btn"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >{theme === 'dark' ? '☀' : '☾'}</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '2px 11px', fontSize: 12 }}>
            <a href="/portal" style={{ color: 'var(--muted)' }}>Customer Portal →</a>
            {me ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                <span style={{ color: 'var(--text)' }} title={me.role ? `Role: ${me.role}` : undefined}>
                  {me.username}
                </span>
                <button
                  onClick={logout}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 12, cursor: 'pointer', padding: 0 }}
                >Sign out</button>
              </span>
            ) : (
              <a href="/login" style={{ color: 'var(--muted)', marginLeft: 'auto' }}>Sign in</a>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
