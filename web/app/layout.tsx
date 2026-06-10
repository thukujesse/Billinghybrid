import './globals.css';
import type { ReactNode } from 'react';
import { Nav } from './components/Nav';

export const metadata = {
  title: 'JTM ISP Billing',
  description: 'Hybrid ISP Billing System',
};

// Set the saved theme on <html> BEFORE first paint so there's no light/dark
// flash on load. Runs inline (not React) since it must execute pre-hydration.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('jtm-theme');document.documentElement.setAttribute('data-theme',(t==='dark'||t==='light')?t:'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
