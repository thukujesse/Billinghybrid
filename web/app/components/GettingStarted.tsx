/**
 * First-run activation checklist. Rendered on the dashboard for freshly
 * provisioned ISPs and hides itself the moment every step is done (the API
 * returns `complete: true`). Presentational + server-rendered — the data comes
 * from GET /dashboard/setup-status, fetched by the dashboard page.
 */
export interface SetupStep {
  key: 'plan' | 'router' | 'payments' | 'branding' | 'customer';
  done: boolean;
}
export interface SetupStatus {
  steps: SetupStep[];
  done: number;
  total: number;
  complete: boolean;
}

const META: Record<SetupStep['key'], { icon: string; title: string; desc: string; href: string; cta: string }> = {
  plan: { icon: '📦', title: 'Create your first plan', desc: 'Set the speed, data cap and price you sell to customers.', href: '/plans', cta: 'Add a plan' },
  router: { icon: '📡', title: 'Connect a router', desc: 'Provision a MikroTik so customers can get online.', href: '/routers', cta: 'Add a router' },
  payments: { icon: '💳', title: 'Set up payments', desc: 'Tell us how customers pay — bank paybill, STK push or an aggregator.', href: '/settings', cta: 'Configure payments' },
  branding: { icon: '🎨', title: 'Brand your hotspot', desc: 'Add your name, colour and logo to the captive-portal page.', href: '/hotspot', cta: 'Customise branding' },
  customer: { icon: '👤', title: 'Add your first customer', desc: 'Onboard a subscriber to start billing and tracking usage.', href: '/customers', cta: 'Add a customer' },
};

export default function GettingStarted({ status }: { status: SetupStatus }) {
  if (status.complete) return null;
  const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  // Order: incomplete steps first (so the next action is always at the top),
  // each group keeping its natural setup order.
  const ordered = [...status.steps].sort((a, b) => Number(a.done) - Number(b.done));

  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '20px 22px', boxShadow: 'var(--shadow)', marginBottom: 14, position: 'relative', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: '#e8590c', textTransform: 'uppercase' }}>Getting started</div>
          <h2 style={{ margin: '6px 0 0', fontSize: 20, fontWeight: 800 }}>Let&rsquo;s get your network earning</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {status.done} of {status.total} done — finish setup to start onboarding customers.
          </p>
        </div>
        <div style={{ textAlign: 'right', minWidth: 120 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#e8590c', lineHeight: 1 }}>{pct}%</div>
          <div style={{ marginTop: 8, height: 8, width: 120, borderRadius: 5, background: 'var(--card-2, rgba(0,0,0,0.06))', overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(4, pct)}%`, height: '100%', background: '#e8590c', borderRadius: 5 }} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {ordered.map((s) => {
          const m = META[s.key];
          return (
            <a key={s.key} href={s.done ? undefined : m.href}
               style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'center', gap: 13, padding: '12px 14px', borderRadius: 11, border: '1px solid var(--border)', background: s.done ? 'var(--green-weak, rgba(22,163,74,0.06))' : 'var(--card)', opacity: s.done ? 0.72 : 1, cursor: s.done ? 'default' : 'pointer' }}>
              <span style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, background: s.done ? 'var(--green-weak, rgba(22,163,74,0.12))' : 'rgba(232,89,12,0.10)', color: s.done ? '#15803d' : '#e8590c' }}>
                {s.done ? '✓' : m.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--muted)' : 'var(--text)' }}>{m.title}</div>
                {!s.done && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{m.desc}</div>}
              </div>
              {s.done
                ? <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d', whiteSpace: 'nowrap' }}>Done</span>
                : <span style={{ fontSize: 12.5, fontWeight: 600, color: '#e8590c', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{m.cta} ›</span>}
            </a>
          );
        })}
      </div>
    </section>
  );
}
