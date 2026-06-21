import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { money } from '@/lib/api';
import { serverApi } from '@/lib/serverApi';
import GettingStarted, { type SetupStatus } from './components/GettingStarted';

export const dynamic = 'force-dynamic';

interface Overview {
  online_now: number;
  total_subscribers: number;
  active_subscriptions: number;
  routers: { total: number; healthy: number; offline: number };
  expiring_24h: number;
  revenue_today_cents: number;
  revenue_yesterday_window_cents: number;
  revenue_delta_pct: number | null;
  traffic_last_hour_bytes: number;
  traffic_series: number[];
  latest_payment: { amount_cents: number; source: string; created_at: string } | null;
  unpaid_invoices: { count: number; total_cents: number };
  renewals_due: Array<{ id: string; full_name: string | null; account_number: string | null; phone: string | null; expiry_date: string; plan_name: string | null }>;
  busiest_routers: Array<{ id: string; name: string; sessions: number; bytes_total: number; pct: number }>;
  today_events: Array<{ kind: string; created_at: string; label: string | null; amount_cents: number | null }>;
}
interface RevenuePoint { month: string; revenue_cents: number }
// The ISP's own brand (their hotspot brand, else their registered tenant name).
interface Branding { name?: string }
interface TenantStatus { name?: string | null }

// ---------- formatting helpers ----------
function greeting(h: number): string {
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Working late';
}
function shift(h: number): string {
  if (h < 5) return 'NIGHT SHIFT';
  if (h < 12) return 'MORNING SHIFT';
  if (h < 17) return 'MIDDAY SHIFT';
  if (h < 21) return 'EVENING SHIFT';
  return 'NIGHT SHIFT';
}
function dayPhrase(h: number): string {
  if (h < 9) return 'The day is just getting started.';
  if (h < 12) return 'Morning rush is on.';
  if (h < 17) return 'The day is in full swing.';
  if (h < 21) return 'Evening peak — keep an eye on capacity.';
  return 'Quiet hours — a good time for maintenance.';
}
function compactKes(cents: number): string {
  const k = cents / 100;
  if (k >= 1_000_000) return `${(k / 1_000_000).toFixed(1)}M`;
  if (k >= 1_000) return `${(k / 1_000).toFixed(1)}k`;
  return `${Math.round(k)}`;
}
function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fromNow(iso: string): string {
  const s = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m from now`;
  return `${m}m ${s % 60}s from now`;
}
function initial(s: string | null): string {
  return (s ?? '?').trim().charAt(0).toUpperCase() || '?';
}
function maskPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (d.length < 6) return p;
  return `${d.slice(0, 6)}···${d.slice(-3)}`;
}

/** Minimal area sparkline (no axes) — pure flourish from a real series. */
function Sparkline({ data, color = 'var(--accent, #e8590c)', w = 150, h = 40 }: { data: number[]; color?: string; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (h - 6) * ((v - min) / span)).toFixed(1)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity={0.10} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function StatCard({ label, value, sub, subTone, spark }: {
  label: string; value: string; sub: string; subTone?: 'up' | 'muted'; spark?: number[];
}) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', boxShadow: 'var(--shadow)', position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 132 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.7, fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--text)', marginTop: 8, lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 12, color: subTone === 'up' ? '#15803d' : 'var(--muted)', marginTop: 8, fontWeight: subTone === 'up' ? 600 : 400 }}>{sub}</div>
      </div>
      {spark && spark.length >= 2 && (
        <div style={{ marginTop: 10, marginLeft: -4, marginBottom: -10 }}>
          <Sparkline data={spark} />
        </div>
      )}
    </div>
  );
}

export default async function Dashboard() {
  const host = (headers().get('host') ?? '').toLowerCase();
  if (host.split('.')[0] === 'support') redirect('/platform');

  const settled = await Promise.allSettled([
    serverApi<Overview>('/dashboard/overview'),
    serverApi<RevenuePoint[]>('/reports/revenue-combined?months=12'),
    serverApi<Branding>('/hotspot/branding'),
    serverApi<TenantStatus>('/tenants/status'),
    serverApi<SetupStatus>('/dashboard/setup-status'),
  ]);
  const ov = settled[0].status === 'fulfilled' ? settled[0].value : null;
  const revenue = settled[1].status === 'fulfilled' ? settled[1].value : [];
  const branding = settled[2].status === 'fulfilled' ? settled[2].value : null;
  const tenant = settled[3].status === 'fulfilled' ? settled[3].value : null;
  const setup = settled[4].status === 'fulfilled' ? settled[4].value : null;
  // Always address the ISP by THEIR brand — never the operator/login or our
  // platform name. Use a CUSTOMISED hotspot brand if set, else the registered
  // tenant name; ignore the platform-default brand ('HUB Networks') so an
  // un-customised tenant shows its own name, not ours.
  const customBrand = branding?.name?.trim();
  const brandName = (customBrand && customBrand !== 'HUB Networks' ? customBrand : '')
    || tenant?.name?.trim() || 'Your network';

  if (!ov) {
    const err = settled[0].status === 'rejected' ? (settled[0].reason?.message ?? 'unknown error') : 'no data';
    return (
      <div className="container">
        <h1>Overview</h1>
        <div className="toast err">Could not reach the API: {err}.</div>
      </div>
    );
  }

  const now = new Date();
  const h = now.getHours();
  const revSpark = revenue.map((r) => r.revenue_cents);
  const onlinePct = ov.total_subscribers > 0 ? Math.round((ov.online_now / ov.total_subscribers) * 100) : 0;
  const delta = ov.revenue_delta_pct;

  // Build the "What's next?" urgent list from live signals.
  const urgent: Array<{ icon: string; title: string; tag?: string; desc: string; href: string }> = [];
  if (ov.routers.offline > 0) urgent.push({ icon: '📡', title: `${ov.routers.offline} router${ov.routers.offline === 1 ? '' : 's'} offline`, tag: 'URGENT', desc: 'Not responding to network monitoring.', href: '/network' });
  if (ov.unpaid_invoices.count > 0) urgent.push({ icon: '🧾', title: `${ov.unpaid_invoices.count} unpaid invoice${ov.unpaid_invoices.count === 1 ? '' : 's'}`, desc: 'Follow up or mark paid before the cycle closes.', href: '/invoices' });
  if (ov.expiring_24h > 0) urgent.push({ icon: '⏳', title: `${ov.expiring_24h} expiring in 24h`, desc: 'Customers about to lapse — nudge them to renew.', href: '/customers' });

  const headLine = [
    ov.routers.offline > 0 ? `${ov.routers.offline} router${ov.routers.offline === 1 ? '' : 's'} offline` : null,
    ov.expiring_24h > 0 ? `${ov.expiring_24h} expir${ov.expiring_24h === 1 ? 'y' : 'ies'} due in 24h` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="container" style={{ maxWidth: 1180 }}>
      {/* ---------- Getting started (hides itself once setup is complete) ---------- */}
      {setup && !setup.complete && <GettingStarted status={setup} />}

      {/* ---------------- Hero ---------------- */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 18, padding: '22px 26px', boxShadow: 'var(--shadow)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, color: 'var(--muted)', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#e8590c' }} />
            {brandName}
            <span style={{ color: '#e8590c' }}>— {ov.online_now} ONLINE RIGHT NOW</span>
            <span>— {shift(h)}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: 'var(--muted)', textTransform: 'uppercase' }}>Traffic · last hour</div>
            <div style={{ marginTop: 2, minHeight: 40 }}><Sparkline data={ov.traffic_series} w={170} h={40} /></div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: -2 }}>{fmtBytes(ov.traffic_last_hour_bytes)} moved</div>
          </div>
        </div>

        <h1 style={{ margin: '14px 0 0', fontSize: 30, fontWeight: 800 }}>
          {greeting(h)}, <em style={{ color: '#e8590c', fontStyle: 'italic' }}>{brandName}</em>.
        </h1>
        <p style={{ margin: '8px 0 0', color: 'var(--text-2, var(--muted))', fontSize: 14 }}>
          {headLine ? `${headLine} — a few things need a minute.` : 'Everything looks healthy right now.'}
        </p>

        <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            ☀️ {dayPhrase(h)}
          </span>
          {delta !== null && delta > 0 && (
            <span style={{ fontSize: 12.5, fontWeight: 600, color: '#e8590c', background: 'rgba(232,89,12,0.08)', border: '1px solid rgba(232,89,12,0.20)', borderRadius: 999, padding: '4px 12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              ✦ {delta}% ahead of yesterday at this hour — nice pace.
            </span>
          )}
        </div>
      </div>

      {/* ---------------- Live ticker ---------------- */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 18px', marginTop: 14, boxShadow: 'var(--shadow)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: '#dc2626', background: 'var(--red-weak, rgba(220,38,38,0.10))', borderRadius: 5, padding: '3px 7px', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#dc2626' }} /> LIVE
          </span>
          {ov.latest_payment ? (
            <span style={{ fontSize: 13.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Payment of <strong>{money(ov.latest_payment.amount_cents)}</strong> from {ov.latest_payment.source}
              <span style={{ color: 'var(--muted)' }}> · {ago(ov.latest_payment.created_at)}</span>
            </span>
          ) : (
            <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>No payments yet today.</span>
          )}
        </div>
        <span style={{ fontSize: 12.5, color: ov.routers.offline > 0 ? '#b45309' : '#15803d', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: ov.routers.offline > 0 ? '#d97706' : '#16a34a' }} />
          {ov.routers.healthy}/{ov.routers.total} routers healthy
        </span>
      </div>

      {/* ---------------- Stat cards ---------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginTop: 14 }}>
        <StatCard label="Revenue today" value={compactKes(ov.revenue_today_cents)}
          sub={delta !== null ? `${delta >= 0 ? '+' : ''}${delta}% vs yesterday` : 'since midnight'}
          subTone={delta !== null && delta >= 0 ? 'up' : 'muted'} spark={revSpark} />
        <StatCard label="Active subscriptions" value={`${ov.active_subscriptions}`}
          sub={`${ov.total_subscribers} subscribers on record`} />
        <StatCard label="Online now" value={`${onlinePct}%`}
          sub={`${ov.online_now} of ${ov.total_subscribers} subscribers online`} />
      </div>

      {/* ---------------- Today + What's next ---------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 16, marginTop: 22 }}>
        <Panel title="Today" badge={`${ov.today_events.length} event${ov.today_events.length === 1 ? '' : 's'}`} sub="Payments, signups and tickets since midnight">
          {ov.today_events.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 0' }}><span className="icon">✨</span>Nothing yet today.</div>
          ) : ov.today_events.slice(0, 6).map((e, i) => (
            <Row key={i}>
              <span style={{ width: 28, height: 28, borderRadius: 8, background: 'rgba(232,89,12,0.10)', color: '#e8590c', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {e.kind === 'payment' ? '➤' : '+'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5 }}>
                  {e.kind === 'payment'
                    ? <>Payment of <strong>{money(Number(e.amount_cents ?? 0))}</strong> from {e.label || 'a customer'}</>
                    : <>New signup — <strong>{e.label || 'customer'}</strong></>}
                </div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{ago(e.created_at)}</span>
            </Row>
          ))}
        </Panel>

        <Panel title="What's next?" badge={urgent.length ? `${urgent.length} urgent` : 'all clear'} badgeTone={urgent.length ? 'warn' : 'ok'} sub="Things that need a decision">
          {urgent.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 0' }}><span className="icon">✅</span>Nothing needs you right now.</div>
          ) : urgent.map((u, i) => (
            <a key={i} href={u.href} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Row hover>
                <span style={{ width: 34, height: 34, borderRadius: 9, background: u.tag ? 'var(--red-weak, rgba(220,38,38,0.10))' : 'rgba(232,89,12,0.10)', color: u.tag ? '#dc2626' : '#e8590c', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0 }}>{u.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {u.title}
                    {u.tag && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, color: '#dc2626', background: 'var(--red-weak, rgba(220,38,38,0.10))', borderRadius: 4, padding: '2px 6px' }}>{u.tag}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{u.desc}</div>
                </div>
                <span style={{ color: 'var(--muted)', flexShrink: 0 }}>›</span>
              </Row>
            </a>
          ))}
        </Panel>
      </div>

      {/* ---------------- Renewals due + Busiest routers ---------------- */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 16, marginTop: 16 }}>
        <Panel title="Renewals due" sub={`Next 48 hours · ${ov.renewals_due.length} subscriber${ov.renewals_due.length === 1 ? '' : 's'}`}>
          {ov.renewals_due.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 0' }}><span className="icon">👍</span>No renewals in the next 48 hours.</div>
          ) : ov.renewals_due.map((r) => (
            <a key={r.id} href="/customers" style={{ textDecoration: 'none', color: 'inherit' }}>
              <Row hover>
                <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(232,89,12,0.10)', color: '#e8590c', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>{initial(r.full_name || r.account_number)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.full_name || r.account_number || 'Customer'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{maskPhone(r.phone)}{r.account_number ? ` · ${r.account_number}` : ''}</div>
                </div>
                <span style={{ fontSize: 12, color: '#b45309', whiteSpace: 'nowrap' }}>{fromNow(r.expiry_date)}</span>
              </Row>
            </a>
          ))}
        </Panel>

        <Panel title="Where the traffic is" sub="Busiest routers · last hour" badge={`${ov.routers.healthy}/${ov.routers.total} healthy`} badgeTone={ov.routers.offline > 0 ? 'warn' : 'ok'}>
          {ov.busiest_routers.length === 0 ? (
            <div className="empty-state" style={{ padding: '24px 0' }}><span className="icon">📶</span>No live traffic right now.</div>
          ) : ov.busiest_routers.map((r) => (
            <a key={r.id} href={`/routers/${r.id}`} style={{ textDecoration: 'none', color: 'inherit', display: 'block', padding: '12px 4px', borderTop: '1px solid var(--border-2, var(--border))' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <strong style={{ fontSize: 13.5, fontFamily: 'monospace' }}>{r.name}</strong>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{r.sessions} sessions · {fmtBytes(r.bytes_total)}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
                <div style={{ flex: 1, height: 7, borderRadius: 5, background: 'var(--card-2, rgba(0,0,0,0.06))', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.max(3, r.pct)}%`, height: '100%', background: '#e8590c', borderRadius: 5 }} />
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', width: 64, textAlign: 'right' }}>{r.pct}% of live</span>
              </div>
            </a>
          ))}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, sub, badge, badgeTone, children }: {
  title: string; sub?: string; badge?: string; badgeTone?: 'ok' | 'warn'; children: React.ReactNode;
}) {
  const tone = badgeTone === 'warn'
    ? { bg: 'var(--orange-weak, rgba(217,119,6,0.10))', fg: 'var(--orange, #b45309)' }
    : badgeTone === 'ok'
    ? { bg: 'var(--green-weak, rgba(22,163,74,0.10))', fg: 'var(--green, #15803d)' }
    : { bg: 'var(--card-2, rgba(0,0,0,0.05))', fg: 'var(--muted)' };
  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 18px', boxShadow: 'var(--shadow)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
          {sub && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{sub}</div>}
        </div>
        {badge && <span style={{ fontSize: 11, fontWeight: 700, color: tone.fg, background: tone.bg, borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>{badge}</span>}
      </div>
      <div style={{ marginTop: 12 }}>{children}</div>
    </section>
  );
}

function Row({ children, hover }: { children: React.ReactNode; hover?: boolean }) {
  return (
    <div className={hover ? 'card hover' : undefined} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px',
      borderTop: '1px solid var(--border-2, var(--border))',
    }}>
      {children}
    </div>
  );
}
