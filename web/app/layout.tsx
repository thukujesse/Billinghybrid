import './globals.css';
import type { ReactNode } from 'react';
import { Nav } from './components/Nav';

export const metadata = {
  title: 'JTM ISP Billing',
  description: 'Hybrid ISP Billing System',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
