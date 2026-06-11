'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, getToken, setToken } from '@/lib/api';

// Hidden on the captive portal + the standalone login page.
const CUSTOMER_PATHS = ['/hotspot', '/renew', '/portal', '/login'];

type Item = { href: string; label: string };
type Group = { key: string; label: string; ico: string; items: Item[] };

// Four top-level areas (Users / Communication / Network / Routers). Dashboard
// is the home item above them; Settings + theme live in the footer.
const GROUPS: Group[] = [
  {
    key: 'users', label: 'Users', ico: '👥', items: [
      { href: '/customers', label: 'Customers' },
      { href: '/leads', label: 'Leads' },
      { href: '/users/hotspot', label: 'Hotspot users' },
      { href: '/plans', label: 'Plans' },
      { href: '/vouchers', label: 'Vouchers' },
      { href: '/invoices', label: 'Invoices' },
      { href: '/payments', label: 'Payments' },
      { href: '/resellers', label: 'Resellers' },
      { href: '/reports', label: 'Reports' },
      { href: '/audit', label: 'Audit' },
    ],
  },
  {
    key: 'comms', label: 'Communication', ico: '💬', items: [
      { href: '/alerts', label: 'Alerts' },
      { href: '/messages', label: 'Message templates' },
      { href: '/ads', label: 'Ads' },
      { href: '/settings#sms', label: 'SMS / Notifications' },
    ],
  },
  {
    key: 'network', label: 'Network', ico: '🌐', items: [
      { href: '/network', label: 'Overview' },
      { href: '/network/twin', label: 'Live map' },
      { href: '/sessions', label: 'Sessions' },
      { href: '/payment-events', label: 'Payment queue' },
      { href: '/plugins', label: 'Plugins' },
    ],
  },
  {
    key: 'routers', label: 'Routers', ico: '📡', items: [
      { href: '/routers', label: 'Routers' },
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
  // Which group accordions are open. Seed with the group owning the active route.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [me, setMe] = useState<{ username?: string; role?: string } | null>(null);

  // Who's signed in (drives the footer). Quietly null if not authenticated.
  useEffect(() => {
    if (typeof window !== 'undefined' && getToken()) {
      api<{ username?: string; role?: string }>('/auth/me').then(setMe).catch(() => setMe(null));
    } else {
      setMe(null);
    }
  }, [pathname]);
  const logout = () => { setToken(null); setMe(null); router.replace('/login'); };

  // Sync local state with what the pre-paint bootstrap already applied.
  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') setTheme(t);
    const s = document.documentElement.getAttribute('data-sidebar');
    setHidden(s === 'hidden');
  }, []);

  // Auto-expand the group that contains the current page.
  useEffect(() => {
    const active = GROUPS.find((g) => g.items.some((i) => isActive(pathname, i.href)));
    if (active) setOpen((o) => (o[active.key] ? o : { ...o, [active.key]: true }));
  }, [pathname]);

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
          <span className="brand">JTM <em>Billing</em></span>
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
            <span className="ico">⌂</span> Dashboard
          </a>

          <div className="sidebar-divider" />

          {GROUPS.map((g) => {
            const groupActive = g.items.some((i) => isActive(pathname, i.href));
            const isOpen = open[g.key] ?? false;
            return (
              <div key={g.key}>
                <button
                  className={`side-link${groupActive && !isOpen ? ' active' : ''}`}
                  aria-expanded={isOpen}
                  onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))}
                >
                  <span className="ico">{g.ico}</span>
                  {g.label}
                  <span className={`chev${isOpen ? ' open' : ''}`}>▶</span>
                </button>
                {isOpen && (
                  <div className="side-sub">
                    {g.items.map((i) => (
                      <a
                        key={i.href}
                        href={i.href}
                        className={isActive(pathname, i.href) ? 'active' : ''}
                        onClick={onNavigate}
                      >{i.label}</a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
