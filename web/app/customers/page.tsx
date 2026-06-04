'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface ServiceSummary {
  id: string;
  service_type: string;
  username: string | null;
  rate_limit: string | null;
  status: string;
  plan_id: string | null;
  plan_name: string | null;
  expiry_date: string | null;
}

interface Customer {
  id: string;
  account_number: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  status: string;
  created_at: string;
  services: ServiceSummary[];
}

interface Plan {
  id: string;
  name: string;
  price_cents: number;
  validity_days: number;
  speed_down_kbps: number | null;
  speed_up_kbps: number | null;
}

interface BulkResult {
  created: Array<{
    row_index: number; account_number: string; full_name: string;
    phone: string | null; username: string; password: string;
  }>;
  errors: Array<{ row_index: number; full_name: string; message: string }>;
}

// Random base32-style password — operators can copy this and SMS to the
// customer. Avoids easily-confused chars (0/O, 1/l/I).
function genPassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function genUsername(fullName: string): string {
  // first letter of first name + lowercase last word, e.g. "Jane Wanjiku" -> "jwanjiku"
  const parts = fullName.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts[0][0] + parts[parts.length - 1];
}

function relativeTime(iso: string | null): { label: string; color: string } {
  if (!iso) return { label: '—', color: 'var(--muted)' };
  const ms = new Date(iso).getTime() - Date.now();
  const s = Math.round(ms / 1000);
  if (s <= 0) {
    const past = Math.abs(s);
    if (past < 3600) return { label: `expired ${Math.round(past / 60)}m ago`, color: '#b91c1c' };
    if (past < 86400) return { label: `expired ${Math.round(past / 3600)}h ago`, color: '#b91c1c' };
    return { label: `expired ${Math.round(past / 86400)}d ago`, color: '#b91c1c' };
  }
  if (s < 3600) return { label: `${Math.round(s / 60)}m left`, color: '#b91c1c' };
  if (s < 86400) return { label: `${Math.round(s / 3600)}h left`, color: '#d97706' };
  if (s < 7 * 86400) return { label: `${Math.round(s / 86400)}d left`, color: '#d97706' };
  return { label: `${Math.round(s / 86400)}d left`, color: '#15803d' };
}

export default function Customers() {
  const [list, setList] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [form, setForm] = useState({
    full_name: '', phone: '', email: '',
    username: '', password: '', plan_id: '',
  });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [renewing, setRenewing] = useState<{ svc: ServiceSummary; planId: string; fromNow: boolean } | null>(null);
  const [changingPlan, setChangingPlan] = useState<{ svc: ServiceSummary; planId: string } | null>(null);
  const [search, setSearch] = useState('');
  // Bulk import modal state. CSV input is free-form (commas OR tabs OR newlines);
  // we parse it on submit and show per-row errors after.
  const [bulk, setBulk] = useState<{
    open: boolean; planId: string; csv: string; busy: boolean;
    result: BulkResult | null;
  }>({ open: false, planId: '', csv: '', busy: false, result: null });

  const load = () =>
    api<Customer[]>('/customers').then(setList)
      .catch((e) => setToast({ ok: false, msg: e.message }));

  const loadPlans = () =>
    api<Plan[]>('/plans')
      .then((all) => setPlans(all.filter((p) => p.price_cents > 0)))
      .catch(() => {/* non-fatal */});

  useEffect(() => {
    load(); loadPlans();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const selectedPlan = plans.find((p) => p.id === form.plan_id);

  // Case-insensitive substring match across the fields an operator might
  // type at the search box. Pure client-side — pagination would push this
  // to the server, but with the customer count of a small ISP this is fine.
  const searchLower = search.trim().toLowerCase();
  const filteredList = !searchLower ? list : list.filter((c) => {
    if (c.full_name.toLowerCase().includes(searchLower)) return true;
    if (c.account_number.toLowerCase().includes(searchLower)) return true;
    if (c.phone && c.phone.toLowerCase().includes(searchLower)) return true;
    if (c.services.some((s) => (s.username ?? '').toLowerCase().includes(searchLower))) return true;
    return false;
  });

  const create = async () => {
    if (!form.full_name) return;
    setCreating(true);
    try {
      const customer = await api<Customer>('/customers', {
        method: 'POST',
        body: JSON.stringify({
          full_name: form.full_name,
          phone: form.phone || undefined,
          email: form.email || undefined,
        }),
      });
      // Auto-generate creds if operator left them blank.
      const username = form.username || genUsername(form.full_name);
      const password = form.password || genPassword();
      if (username && password) {
        await api(`/customers/${customer.id}/services`, {
          method: 'POST',
          body: JSON.stringify({
            service_type: 'pppoe',
            username,
            password,
            plan_id: form.plan_id || undefined,
          }),
        });
      }
      const credsMsg = (form.username && form.password)
        ? `Created ${customer.account_number}`
        : `Created ${customer.account_number} · creds: ${username} / ${password}`;
      setToast({ ok: true, msg: credsMsg });
      setForm({ full_name: '', phone: '', email: '', username: '', password: '', plan_id: '' });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setCreating(false);
    }
  };

  const setStatus = async (svc: ServiceSummary, status: string) => {
    setBusy(svc.id);
    try {
      await api(`/services/${svc.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      setToast({
        ok: true,
        msg: status === 'active'
          ? `Restored ${svc.username} — captive redirect cleared`
          : `Suspended ${svc.username} — captive redirect armed on all routers`,
      });
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  };

  const doChangePlan = async () => {
    if (!changingPlan?.planId) return;
    setBusy(changingPlan.svc.id);
    try {
      await api(`/services/${changingPlan.svc.id}/plan`, {
        method: 'PATCH',
        body: JSON.stringify({ planId: changingPlan.planId }),
      });
      setToast({ ok: true, msg: `Changed plan for ${changingPlan.svc.username}` });
      setChangingPlan(null);
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  };

  // Parse CSV / TSV / one-per-line input into structured rows.
  // Accepted column orders: "name, phone" or "name, phone, email".
  // Empty lines + `#` comments ignored.
  const parseBulkCsv = (csv: string) => {
    const rows: Array<{ full_name: string; phone?: string; email?: string }> = [];
    for (const raw of csv.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(/[\t,]/).map((s) => s.trim()).filter((_, i) => i < 4);
      if (!cols[0]) continue;
      rows.push({
        full_name: cols[0],
        phone: cols[1] || undefined,
        email: cols[2] || undefined,
      });
    }
    return rows;
  };

  const doBulkImport = async () => {
    if (!bulk.planId) {
      setToast({ ok: false, msg: 'Pick a plan first.' });
      return;
    }
    const rows = parseBulkCsv(bulk.csv);
    if (rows.length === 0) {
      setToast({ ok: false, msg: 'No valid rows to import. Paste at least one name.' });
      return;
    }
    setBulk((b) => ({ ...b, busy: true, result: null }));
    try {
      const r = await api<BulkResult>('/admin/customers/bulk-import', {
        method: 'POST',
        body: JSON.stringify({ plan_id: bulk.planId, rows }),
      });
      setBulk((b) => ({ ...b, busy: false, result: r }));
      load();
      setToast({
        ok: r.errors.length === 0,
        msg: `Imported ${r.created.length}${r.errors.length ? ` · ${r.errors.length} errors` : ''}`,
      });
    } catch (e: any) {
      setBulk((b) => ({ ...b, busy: false }));
      setToast({ ok: false, msg: e.message });
    }
  };

  // Plain-text creds dump the operator can copy-paste into SMS / WhatsApp.
  const credsClipboardText = (created: BulkResult['created']) =>
    created.map((c) => `${c.full_name}: ${c.username} / ${c.password}${c.phone ? ` (${c.phone})` : ''}`).join('\n');

  const copyCreds = async (created: BulkResult['created']) => {
    try {
      await navigator.clipboard.writeText(credsClipboardText(created));
      setToast({ ok: true, msg: `${created.length} creds copied to clipboard` });
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    }
  };

  const doRenew = async () => {
    if (!renewing) return;
    setBusy(renewing.svc.id);
    try {
      await api(`/services/${renewing.svc.id}/renew`, {
        method: 'POST',
        body: JSON.stringify({
          planId: renewing.planId || undefined,
          fromNow: renewing.fromNow,
        }),
      });
      setToast({ ok: true, msg: `Renewed ${renewing.svc.username}` });
      setRenewing(null);
      load();
    } catch (e: any) {
      setToast({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="container">
      <h1>Customers (PPPoE)</h1>
      <p className="sub">
        Pick a plan to auto-fill rate-limit + expiry. Suspend / restore is instant — the captive
        redirect on every managed MikroTik toggles via the <code>jtm-expired</code> address-list.
        Auto-expire sweeps hourly; click Renew to bypass M-Pesa.
      </p>
      {toast && <div className={`toast ${toast.ok ? 'ok' : 'err'}`}>{toast.msg}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>New PPPoE customer</h3>
        <div className="row">
          <div>
            <label>Full name *</label>
            <input value={form.full_name} placeholder="Jane Wanjiku"
              onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </div>
          <div>
            <label>Phone</label>
            <input value={form.phone} placeholder="07XX XXX XXX"
              onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label>Email</label>
            <input value={form.email} placeholder="jane@example.com"
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <div style={{ flex: 2 }}>
            <label>Plan *</label>
            <select value={form.plan_id} onChange={(e) => setForm({ ...form, plan_id: e.target.value })}>
              <option value="">— pick a plan —</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                  {p.speed_down_kbps && p.speed_up_kbps ? ` · ${p.speed_up_kbps}k/${p.speed_down_kbps}k` : ''}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Username <small style={{ color: 'var(--muted)' }}>(auto if blank)</small></label>
            <input value={form.username} placeholder={form.full_name ? genUsername(form.full_name) : 'jwanjiku'}
              onChange={(e) => setForm({ ...form, username: e.target.value })} />
          </div>
          <div style={{ flex: 1 }}>
            <label>Password <small style={{ color: 'var(--muted)' }}>(auto if blank)</small></label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input value={form.password} placeholder="auto-generate"
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                style={{ flex: 1 }} />
              <button type="button" className="ghost" onClick={() => setForm({ ...form, password: genPassword() })}
                style={{ flex: '0 0 auto', padding: '4px 10px', fontSize: 11 }}>↻</button>
            </div>
          </div>
        </div>

        {selectedPlan && (
          <p className="sub" style={{ marginTop: 8 }}>
            <strong>{selectedPlan.name}</strong> · expires {selectedPlan.validity_days} days from creation
            {selectedPlan.speed_down_kbps && selectedPlan.speed_up_kbps && (
              <> · rate {selectedPlan.speed_up_kbps}k/{selectedPlan.speed_down_kbps}k</>
            )}
          </p>
        )}

        <button disabled={!form.full_name || !form.plan_id || creating} onClick={create} style={{ marginTop: 12 }}>
          {creating ? 'Creating…' : 'Create customer + service'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '20px 0 8px 0' }}>
        <input
          value={search}
          placeholder="Search by name, account, phone, username"
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="ghost" onClick={() => setBulk((b) => ({ ...b, open: true, result: null }))}>
          Bulk import
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Service</th>
            <th>Plan</th>
            <th>Expiry</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {filteredList.flatMap((c) => {
            if (c.services.length === 0) {
              return [(
                <tr key={c.id}>
                  <td><a href={`/customers/${c.id}`} style={{ color: 'inherit' }}><code>{c.account_number}</code></a></td>
                  <td><a href={`/customers/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><strong>{c.full_name}</strong></a></td>
                  <td>{c.phone ?? '—'}</td>
                  <td colSpan={5} style={{ color: 'var(--muted)' }}>no service</td>
                </tr>
              )];
            }
            return c.services.map((s, i) => {
              const exp = relativeTime(s.expiry_date);
              return (
                <tr key={s.id}>
                  {i === 0 ? <td rowSpan={c.services.length}><a href={`/customers/${c.id}`} style={{ color: 'inherit' }}><code>{c.account_number}</code></a></td> : null}
                  {i === 0 ? <td rowSpan={c.services.length}><a href={`/customers/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}><strong>{c.full_name}</strong></a></td> : null}
                  {i === 0 ? <td rowSpan={c.services.length}>{c.phone ?? '—'}</td> : null}
                  <td>
                    <code>{s.username ?? '—'}</code>
                    <small style={{ color: 'var(--muted)', marginLeft: 6 }}>{s.service_type}</small>
                    {s.rate_limit && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.rate_limit}</div>}
                  </td>
                  <td style={{ fontSize: 13 }}>{s.plan_name ?? <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                  <td style={{ fontSize: 12, color: exp.color, whiteSpace: 'nowrap' }}>{exp.label}</td>
                  <td>
                    <span className={`badge ${
                      s.status === 'active' ? 'active' :
                      s.status === 'suspended' ? 'suspended' : 'pending'
                    }`}>{s.status}</span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                              disabled={busy === s.id}
                              onClick={() => setRenewing({ svc: s, planId: s.plan_id ?? '', fromNow: s.status !== 'active' })}>
                        Renew
                      </button>
                      <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                              disabled={busy === s.id}
                              onClick={() => setChangingPlan({ svc: s, planId: s.plan_id ?? '' })}>
                        Change plan
                      </button>
                      {s.status === 'active' ? (
                        <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                                disabled={busy === s.id}
                                onClick={() => setStatus(s, 'suspended')}>
                          {busy === s.id ? '…' : 'Suspend'}
                        </button>
                      ) : (
                        <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                                disabled={busy === s.id}
                                onClick={() => setStatus(s, 'active')}>
                          {busy === s.id ? '…' : 'Restore'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            });
          })}
          {list.length === 0 && (
            <tr><td colSpan={8} style={{ color: 'var(--muted)' }}>No customers yet</td></tr>
          )}
        </tbody>
      </table>

      {renewing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setRenewing(null)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Renew {renewing.svc.username}</h3>
            <p className="sub">Skips M-Pesa. Use for cash payments, comps, or fixes.</p>

            <label>Plan</label>
            <select value={renewing.planId}
              onChange={(e) => setRenewing({ ...renewing, planId: e.target.value })}>
              <option value="">— keep current plan —</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                </option>
              ))}
            </select>

            <label style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={renewing.fromNow}
                onChange={(e) => setRenewing({ ...renewing, fromNow: e.target.checked })}
                style={{ width: 'auto' }} />
              Start window from now (uncheck to stack onto existing expiry)
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={doRenew} disabled={busy === renewing.svc.id}>
                {busy === renewing.svc.id ? 'Renewing…' : 'Confirm renewal'}
              </button>
              <button className="ghost" onClick={() => setRenewing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {changingPlan && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }} onClick={() => setChangingPlan(null)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, maxWidth: 420, width: '90%',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Change plan · {changingPlan.svc.username}</h3>
            <p className="sub">
              Swaps the plan + speed only. Expiry stays where it is — customer keeps the days they paid for.
              To extend the window too, use Renew instead.
            </p>

            <label>New plan</label>
            <select value={changingPlan.planId}
              onChange={(e) => setChangingPlan({ ...changingPlan, planId: e.target.value })}>
              <option value="">— pick a plan —</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                  {p.speed_down_kbps && p.speed_up_kbps ? ` · ${p.speed_up_kbps}k/${p.speed_down_kbps}k` : ''}
                </option>
              ))}
            </select>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={doChangePlan} disabled={!changingPlan.planId || busy === changingPlan.svc.id}>
                {busy === changingPlan.svc.id ? 'Saving…' : 'Confirm change'}
              </button>
              <button className="ghost" onClick={() => setChangingPlan(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {bulk.open && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16,
        }} onClick={() => !bulk.busy && setBulk((b) => ({ ...b, open: false }))}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, maxWidth: 640, width: '100%', maxHeight: '90vh', overflow: 'auto',
          }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Bulk import customers</h3>
            <p className="sub">
              Paste one customer per line: <code>Name, Phone, Email</code>. Phone + email optional.
              Commas, tabs, and Excel-pasted rows all work. Up to 500 rows. Username + password auto-generate.
            </p>

            {!bulk.result ? (
              <>
                <label>Plan for all imported customers</label>
                <select value={bulk.planId}
                  onChange={(e) => setBulk((b) => ({ ...b, planId: e.target.value }))}>
                  <option value="">— pick a plan —</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · KES {(p.price_cents / 100).toFixed(0)} · {p.validity_days}d
                    </option>
                  ))}
                </select>

                <label style={{ marginTop: 12 }}>Rows</label>
                <textarea
                  value={bulk.csv}
                  onChange={(e) => setBulk((b) => ({ ...b, csv: e.target.value }))}
                  rows={10}
                  placeholder={'Jane Wanjiku, 0712345678\nPeter Otieno, 0723456789, peter@example.com\n# lines starting with # are ignored'}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
                />
                <p className="sub" style={{ fontSize: 11 }}>
                  {parseBulkCsv(bulk.csv).length} valid row(s) detected
                </p>

                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button onClick={doBulkImport} disabled={!bulk.planId || bulk.busy || parseBulkCsv(bulk.csv).length === 0}>
                    {bulk.busy ? 'Importing…' : `Import ${parseBulkCsv(bulk.csv).length}`}
                  </button>
                  <button className="ghost" onClick={() => setBulk((b) => ({ ...b, open: false }))} disabled={bulk.busy}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={`toast ${bulk.result.errors.length === 0 ? 'ok' : 'err'}`} style={{ marginBottom: 12 }}>
                  Imported <strong>{bulk.result.created.length}</strong>
                  {bulk.result.errors.length > 0 && <> · <strong>{bulk.result.errors.length}</strong> errors</>}
                </div>

                {bulk.result.created.length > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>Generated credentials</strong>
                      <button className="ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => copyCreds(bulk.result!.created)}>
                        Copy all
                      </button>
                    </div>
                    <table style={{ fontSize: 12 }}>
                      <thead>
                        <tr><th>Name</th><th>Phone</th><th>Username</th><th>Password</th></tr>
                      </thead>
                      <tbody>
                        {bulk.result.created.map((c) => (
                          <tr key={c.account_number}>
                            <td>{c.full_name}</td>
                            <td>{c.phone ?? '—'}</td>
                            <td><code>{c.username}</code></td>
                            <td><code>{c.password}</code></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {bulk.result.errors.length > 0 && (
                  <>
                    <strong style={{ fontSize: 13, display: 'block', marginTop: 12, marginBottom: 6, color: '#b91c1c' }}>
                      Errors
                    </strong>
                    <table style={{ fontSize: 12 }}>
                      <thead><tr><th>Row</th><th>Name</th><th>Reason</th></tr></thead>
                      <tbody>
                        {bulk.result.errors.map((e) => (
                          <tr key={e.row_index}>
                            <td>{e.row_index + 1}</td>
                            <td>{e.full_name}</td>
                            <td style={{ color: '#b91c1c' }}>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button onClick={() => setBulk({ open: false, planId: '', csv: '', busy: false, result: null })}>
                    Close
                  </button>
                  <button className="ghost"
                    onClick={() => setBulk((b) => ({ ...b, result: null, csv: '' }))}>
                    Import another batch
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}