import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'JTM ISP Billing',
  description: 'Hybrid ISP Billing System',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <span className="brand">JTM <em>Billing</em></span>
          <a href="/">Dashboard</a>
          <a href="/subscribers">Subscribers</a>
          <a href="/plans">Plans</a>
          <a href="/invoices">Invoices</a>
          <a href="/payments">Payments</a>
          <a href="/vouchers">Vouchers</a>
          <a href="/resellers">Resellers</a>
          <a href="/portal" style={{ marginLeft: 'auto' }}>Customer Portal →</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
