'use client';
import { usePathname } from 'next/navigation';

// Admin nav. Hidden on customer-facing routes so a paying customer at
// billing.hubnetwifi.co.ke doesn't see "Dashboard / Reports / Users /
// Plans / ..." stacked above the captive portal card.
const CUSTOMER_PATHS = ['/hotspot', '/renew', '/portal'];

export function Nav() {
  const pathname = usePathname() ?? '';
  if (CUSTOMER_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return null;
  }
  return (
    <nav className="nav">
      <span className="brand">JTM <em>Billing</em></span>
      <a href="/">Dashboard</a>
      <a href="/reports">Reports</a>
      <a href="/users/hotspot">Users</a>
      <a href="/plans">Plans</a>
      <a href="/invoices">Invoices</a>
      <a href="/payments">Payments</a>
      <a href="/payment-events">Queue</a>
      <a href="/alerts">Alerts</a>
      <a href="/audit">Audit</a>
      <a href="/vouchers">Vouchers</a>
      <a href="/resellers">Resellers</a>
      <a href="/routers">Routers</a>
      <a href="/network">Network</a>
      <a href="/sessions">Sessions</a>
      <a href="/plugins">Plugins</a>
      <a href="/settings">Settings</a>
      <a href="/login" style={{ marginLeft: 'auto' }}>Sign in</a>
      <a href="/portal">Customer Portal →</a>
    </nav>
  );
}