import { api, money } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface RevenuePoint {
  month: string;
  revenue_cents: number;
  hotspot_guest_cents: number;
  pppoe_renewal_cents: number;
}

interface OutstandingBucket { count: number; potential_cents: number }
interface Outstanding {
  expiring_24h: OutstandingBucket;
  expiring_7d: OutstandingBucket;
  expired_grace_7d: OutstandingBucket;
}

interface PppoeMrr { active_count: number; mrr_cents: number }

interface AlertRow {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  status: 'open' | 'acked' | 'resolved';
  opened_at: string;
}

/** Tiny inline sparkline — 12 monthly revenue points → polyline area chart. */
function Sparkline({ data, color = '#2563eb', height = 36, width = 160 }: {
  data: number[]; color?: string; height?: number; width?: number;
}) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = height - (height - 4) * (v / max) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const area = `0,${height} ${pts} ${width},${height}`;
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={area} fill={`${color}22`} stroke="none" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
}

function HeroCard({
  label, value, sublabel, sublabelColor, accent, sparkline, accentBar,
}: {
  label: string;
  value: string;
  sublabel?: string;
  sublabelColor?: string;
  accent: string;
  sparkline?: number[];
  accentBar?: boolean;
}) {
  return (
    <div style={{
      background: '#fff',
      border: '1px solid #e2e8f0',
      borderRadius: 12,
      padding: '16px 18px',
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
      minHeight: 110,
      position: 'relative',
      overflow: 'hidden',
      boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
    }}>
      {accentBar && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: accent,
        }} />
      )}
      <div>
        <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700 }}>
          {label}
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a', marginTop: 6, lineHeight: 1.1 }}>
          {value}
        </div>
        {sublabel && (
          <div style={{ fontSize: 11, color: sublabelColor ?? '#94a3b8', marginTop: 4 }}>
            {sublabel}
          </div>
        )}
      </div>
      {sparkline && sparkline.length >= 2 && (
        <div style={{ marginTop: 8, marginLeft: -4 }}>
          <Sparkline data={sparkline} color={accent} />
        </div>
      )}
    </div>
  );
}

function StatusPill({
  label, count, tone,
}: { label: string; count: number; tone: 'ok' | 'warn' | 'crit' | 'mute' }) {
  const colors = {
    ok:   { bg: 'rgba(22,163,74,0.10)',  fg: '#15803d', dot: '#22c55e' },
    warn: { bg: 'rgba(217,119,6,0.10)',  fg: '#a16207', dot: '#d97706' },
    crit: { bg: 'rgba(220,38,38,0.10)',  fg: '#b91c1c', dot: '#dc2626' },
    mute: { bg: 'rgba(100,116,139,0.08)', fg: '#475569', dot: '#94a3b8' },
  }[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: colors.bg, color: colors.fg,
      padding: '4px 10px 4px 8px', borderRadius: 999,
      fontSize: 12, fontWeight: 600,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: colors.dot,
        boxShadow: tone === 'crit' ? '0 0 6px currentColor' : undefined,
      }} />
      {count} {label}
    </span>
  );
}

function QuickActionTile({
  href, icon, label, description,
}: { href: string; icon: string; label: string; description: string }) {
  return (
    <a href={href} style={{
      background: '#fff',
      border: '1px solid #e2e8f0',
      borderRadius: 10,
      padding: 14,
      display: 'flex', alignItems: 'center', gap: 12,
      textDecoration: 'none', color: 'inherit',
      transition: 'border-color 0.15s, transform 0.15s',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8,
        background: 'rgba(37,99,235,0.10)', color: '#2563eb',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 18, fontWeight: 700, flexShrink: 0,
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{label}</div>
        <div style={{ fontSize: 11, color: '#64748b' }}>{description}</div>
      </div>
    </a>
  );
}

export default async function Dashboard() {
  let data: any = null;
  let revenue: RevenuePoint[] = [];
  let outstanding: Outstanding | null = null;
  let mrr: PppoeMrr | null = null;
  let openAlerts: AlertRow[] = [];
  let error: string | null = null;
  try {
    // Headline tile + supporting series in parallel — page is server-rendered
    // so this is one round-trip from the operator's POV.
    [data, revenue, outstanding, mrr, openAlerts] = await Promise.all([
      api('/dashboard'),
      api<RevenuePoint[]>('/reports/revenue-combined?months=12'),
      api<Outstanding>('/reports/outstanding-renewals'),
      api<PppoeMrr>('/reports/pppoe-mrr'),
      api<AlertRow[]>('/admin/alerts?status=open&limit=5'),
    ]);
  } catch (e: any) {
    error = e.message;
  }

  if (error) {
    return (
      <div className="container">
        <h1>Dashboard</h1>
        <div className="toast err">Could not reach the API: {error}.</div>
      </div>
    );
  }

  const subs = data.subscribers ?? {};
  const pppoe = data.pppoe ?? { active: 0, expired: 0, suspended: 0, expiring_24h: 0 };
  const revSpark = revenue.map((r) => r.revenue_cents);
  const total12mo = revenue.reduce((a, b) => a + b.revenue_cents, 0);
  const lastMonth = revenue.length > 0 ? revenue[revenue.length - 1].revenue_cents : 0;
  const prevMonth = revenue.length > 1 ? revenue[revenue.length - 2].revenue_cents : 0;
  const momPct = prevMonth > 0 ? Math.round(((lastMonth - prevMonth) / prevMonth) * 100) : null;
  const outstandingTotal =
    (outstanding?.expiring_24h.potential_cents ?? 0) +
    (outstanding?.expiring_7d.potential_cents ?? 0);
  const critAlerts = openAlerts.filter((a) => a.severity === 'critical').length;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  return (
    <div className="container">
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        flexWrap: 'wrap', gap: 12, marginBottom: 6,
      }}>
        <div>
          <h1 style={{ margin: 0 }}>{greeting}</h1>
          <p className="sub" style={{ margin: 0 }}>
            Here's what's happening across HUB Networks right now.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {critAlerts > 0 && <StatusPill label="critical alerts" count={critAlerts} tone="crit" />}
          {pppoe.expired > 0 && <StatusPill label="expired services" count={pppoe.expired} tone="crit" />}
          {pppoe.expiring_24h > 0 && <StatusPill label="expiring <24h" count={pppoe.expiring_24h} tone="warn" />}
          <StatusPill label="active PPPoE" count={pppoe.active} tone="ok" />
        </div>
      </div>

      {/* Hero strip — the four numbers an operator cares about every morning. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 14, marginTop: 20,
      }}>
        <HeroCard
          label="Revenue · 12 mo"
          value={money(total12mo)}
          sublabel={momPct !== null ? `${momPct >= 0 ? '↗' : '↘'} ${momPct >= 0 ? '+' : ''}${momPct}% vs prior month` : 'first month'}
          sublabelColor={momPct === null ? '#94a3b8' : momPct >= 0 ? '#15803d' : '#b91c1c'}
          accent="#2563eb"
          accentBar
          sparkline={revSpark}
        />
        <HeroCard
          label="PPPoE MRR"
          value={money(mrr?.mrr_cents ?? 0)}
          sublabel={`${mrr?.active_count ?? 0} active monthly customers`}
          accent="#22c55e"
          accentBar
        />
        <HeroCard
          label="Renewals at risk · 7d"
          value={money(outstandingTotal)}
          sublabel={`${(outstanding?.expiring_24h.count ?? 0) + (outstanding?.expiring_7d.count ?? 0)} expiring soon`}
          sublabelColor={outstandingTotal > 0 ? '#d97706' : '#94a3b8'}
          accent="#d97706"
          accentBar
        />
        <HeroCard
          label="Settled payments"
          value={String(data.revenue.payments ?? 0)}
          sublabel={`${money(data.revenue.total_cents)} processed lifetime`}
          accent="#6d28d9"
          accentBar
        />
      </div>

      {/* Quick actions — six big things operators do. */}
      <h2 style={{ marginTop: 32, fontSize: 16 }}>Quick actions</h2>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 10,
      }}>
        <QuickActionTile href="/customers" icon="+" label="New PPPoE customer" description="Onboard a customer + service" />
        <QuickActionTile href="/users/hotspot" icon="◴" label="Hotspot users" description="Live grants + STK status" />
        <QuickActionTile href="/network" icon="▲" label="Network monitor" description="Routers + sessions + bandwidth" />
        <QuickActionTile href="/diagnostics" icon="◎" label="Captive diagnostics" description="Trace MAC or phone through the portal" />
        <QuickActionTile href="/alerts" icon="!" label="Alerts" description={`${openAlerts.length} open`} />
        <QuickActionTile href="/reports" icon="$" label="Reports" description="Revenue + CSV exports" />
        <QuickActionTile href="/settings" icon="⚙" label="Settings" description="M-Pesa + SMS + branding" />
      </div>

      {/* Two-column grid: PPPoE health on the left, recent activity right. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
        gap: 16, marginTop: 32,
      }}>
        <section>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>PPPoE state</h2>
          <div style={{
            background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden',
          }}>
            {[
              { label: 'Active', value: pppoe.active, color: '#15803d', dot: '#22c55e' },
              { label: 'Expiring < 24h', value: pppoe.expiring_24h, color: pppoe.expiring_24h > 0 ? '#a16207' : '#94a3b8', dot: '#d97706' },
              { label: 'Expired', value: pppoe.expired, color: pppoe.expired > 0 ? '#b91c1c' : '#94a3b8', dot: '#dc2626' },
              { label: 'Suspended', value: pppoe.suspended, color: '#475569', dot: '#94a3b8' },
            ].map((row, i) => (
              <div key={row.label} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 16px',
                borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: row.dot }} />
                  <span style={{ fontSize: 13, color: '#475569' }}>{row.label}</span>
                </div>
                <strong style={{ color: row.color, fontSize: 16 }}>{row.value}</strong>
              </div>
            ))}
          </div>

          {totalCount(subs) > 0 && (
            <>
              <h2 style={{ fontSize: 14, marginTop: 20, color: '#64748b' }}>Legacy subscribers</h2>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {Object.entries(subs).map(([k, v]) => (
                  <span key={k} style={{
                    background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6,
                    padding: '4px 10px', fontSize: 12,
                  }}>
                    {k}: <strong>{String(v)}</strong>
                  </span>
                ))}
              </div>
            </>
          )}
        </section>

        <section>
          <h2 style={{ fontSize: 16, marginTop: 0 }}>Recent activity</h2>
          {(data.recent_payments ?? []).length === 0 ? (
            <p className="sub">No payments yet.</p>
          ) : (
            <div style={{
              background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden',
            }}>
              {(data.recent_payments ?? []).slice(0, 6).map((p: any, i: number) => (
                <div key={p.id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px',
                  borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {money(Number(p.amount_cents))}
                      <span style={{
                        marginLeft: 8, fontSize: 10, padding: '2px 6px', borderRadius: 4,
                        background: p.status === 'success' ? 'rgba(22,163,74,0.12)' : 'rgba(217,119,6,0.12)',
                        color: p.status === 'success' ? '#15803d' : '#a16207',
                        textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.4,
                      }}>{p.status}</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8' }}>{p.provider}</div>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', textAlign: 'right', flexShrink: 0 }}>
                    {new Date(p.created_at).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}

          {openAlerts.length > 0 && (
            <>
              <h2 style={{ fontSize: 14, marginTop: 20, color: '#64748b' }}>Open alerts</h2>
              <div style={{
                background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden',
              }}>
                {openAlerts.map((a, i) => (
                  <a key={a.id} href="/alerts" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', textDecoration: 'none', color: 'inherit',
                    borderTop: i === 0 ? 'none' : '1px solid #f1f5f9',
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                      background: a.severity === 'critical' ? '#dc2626' : a.severity === 'warning' ? '#d97706' : '#2563eb',
                      boxShadow: a.severity === 'critical' ? '0 0 6px currentColor' : undefined,
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: '#0f172a' }}>{a.message}</div>
                      <div style={{ fontSize: 10, color: '#94a3b8' }}>
                        {a.kind} · opened {new Date(a.opened_at).toLocaleString()}
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Invoices summary — keep as the existing table for compat. */}
      {(data.invoices ?? []).length > 0 && (
        <>
          <h2 style={{ marginTop: 32, fontSize: 16 }}>Invoices by status</h2>
          <table>
            <thead><tr><th>Status</th><th>Count</th><th>Amount</th></tr></thead>
            <tbody>
              {data.invoices.map((r: any) => (
                <tr key={r.status}>
                  <td><span className={`badge ${r.status}`}>{r.status}</span></td>
                  <td>{r.n}</td>
                  <td>{money(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function totalCount(obj: Record<string, any>): number {
  return Object.values(obj).reduce((a, b) => a + Number(b), 0);
}
