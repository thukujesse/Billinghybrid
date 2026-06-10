'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

// Admin nav. Hidden on customer-facing routes so a paying customer at
// billing.hubnetwifi.co.ke doesn't see "Dashboard / Reports / Users /
// Plans / ..." stacked above the captive portal card.
const CUSTOMER_PATHS = ['/hotspot', '/renew', '/portal'];

const LINKS: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Dashboard' },
  { href: '/reports', label: 'Reports' },
  { href: '/users/hotspot', label: 'Users' },
  { href: '/plans', label: 'Plans' },
  { href: '/invoices', label: 'Invoices' },
  { href: '/payments', label: 'Payments' },
  { href: '/payment-events', label: 'Queue' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/audit', label: 'Audit' },
  { href: '/vouchers', label: 'Vouchers' },
  { href: '/resellers', label: 'Resellers' },
  { href: '/routers', label: 'Routers' },
  { href: '/network', label: 'Network' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/plugins', label: 'Plugins' },
  { href: '/settings', label: 'Settings' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

export function Nav() {
  const pathname = usePathname() ?? '';
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [menuOpen, setMenuOpen] = useState(false);

  // Read the theme the bootstrap script already applied to <html>.
  useEffect(() => {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') setTheme(t);
  }, []);

  // Close the mobile menu on navigation.
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('jtm-theme', next); } catch { /* ignore */ }
  };

  if (CUSTOMER_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return null;
  }

  return (
    <nav className="nav">
      <span className="brand">JTM <em>Billing</em></span>

      <button
        className="nav-icon-btn nav-hamburger"
        aria-label="Menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {menuOpen ? '✕' : '☰'}
      </button>

      <div className={`nav-links${menuOpen ? ' open' : ''}`}>
        {LINKS.map((l) => (
          <a key={l.href} href={l.href} className={isActive(pathname, l.href) ? 'active' : ''}>
            {l.label}
          </a>
        ))}
        <a href="/login" style={{ marginLeft: 'auto' }}>Sign in</a>
        <a href="/portal">Customer Portal →</a>
        <button
          className="nav-icon-btn"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          style={{ marginLeft: 6 }}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    </nav>
  );
}
