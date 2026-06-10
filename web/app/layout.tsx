import './globals.css';
import type { ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';

export const metadata = {
  title: 'JTM ISP Billing',
  description: 'Hybrid ISP Billing System',
};

// Set the saved theme on <html> BEFORE first paint so there's no light/dark
// flash on load. Runs inline (not React) since it must execute pre-hydration.
const themeBootstrap = `(function(){var d=document.documentElement;try{var t=localStorage.getItem('jtm-theme');d.setAttribute('data-theme',(t==='dark'||t==='light')?t:'light');var p=location.pathname,cust=/^\\/(hotspot|renew|portal)(\\/|$)/.test(p),s=localStorage.getItem('jtm-sidebar');if(cust){s='hidden';}else if(s!=='hidden'&&s!=='shown'){s=window.innerWidth<860?'hidden':'shown';}d.setAttribute('data-sidebar',s);}catch(e){d.setAttribute('data-theme','light');d.setAttribute('data-sidebar','shown');}})();`;

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
        <Sidebar />
        <div className="app-main">{children}</div>
      </body>
    </html>
  );
}
