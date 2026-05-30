import { api } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function Plugins() {
  let list: any[] = [];
  let error: string | null = null;
  try { list = await api('/plugins'); } catch (e: any) { error = e.message; }

  if (error) return <div className="container"><h1>Plugins</h1><div className="toast err">API error: {error}</div></div>;

  return (
    <div className="container">
      <h1>Plugin Manager</h1>
      <p className="sub">Extensions loaded at startup. Plugins subscribe to domain events and mount routes under <code>/api/ext/&lt;id&gt;</code> without touching core code.</p>

      <table>
        <thead><tr><th>Plugin</th><th>Version</th><th>Description</th><th>Hooks</th><th>Routes</th><th>Status</th></tr></thead>
        <tbody>
          {list.map((p: any) => (
            <tr key={p.manifest.id}>
              <td>{p.manifest.name} <span style={{ color: 'var(--muted)' }}>({p.manifest.id})</span></td>
              <td>{p.manifest.version}</td>
              <td style={{ color: 'var(--muted)' }}>{p.manifest.description ?? '—'}</td>
              <td>{p.hooks}</td>
              <td>{p.routes}</td>
              <td><span className={`badge ${p.enabled ? 'active' : 'suspended'}`}>{p.enabled ? 'enabled' : 'disabled'}</span></td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No plugins registered</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
