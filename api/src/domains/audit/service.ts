/**
 * Audit log — captures who-did-what for every mutation that an operator
 * or compliance review might need to reconstruct. Records actor (admin,
 * customer, or system worker), entity, before/after JSONB snapshots,
 * and freeform metadata.
 *
 * Failure to log NEVER blocks the underlying mutation — every call is
 * try/catch wrapped at the call site OR uses logAuditSafe. The audit
 * trail being incomplete is preferable to a silent service failure.
 */
import { query } from '../../db/pool.js';
import { currentActor } from '../../lib/actor.js';

export interface AuditEntry {
  id: string;
  created_at: string;
  kind: string;
  entity_type: string;
  entity_id: string;
  actor_id: string;
  actor_label: string;
  actor_role: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

export interface LogInput {
  kind: string;
  entity_type: string;
  entity_id: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Override actor explicitly when ALS context isn't reliable (e.g.
   *  background worker that already has the actor in scope as an arg). */
  actor?: { id: string; label: string; role: string };
}

export async function logAudit(input: LogInput): Promise<void> {
  const actor = input.actor ?? currentActor();
  await query(
    `INSERT INTO audit_log
       (kind, entity_type, entity_id, actor_id, actor_label, actor_role, before, after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [
      input.kind,
      input.entity_type,
      input.entity_id,
      actor.id,
      actor.label,
      actor.role,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      JSON.stringify(input.metadata ?? {}),
    ]
  );
}

/** Fire-and-forget variant — never throws, logs DB errors to stderr. Use
 *  inside service methods to avoid wrapping every call in try/catch. */
export function logAuditSafe(input: LogInput): void {
  logAudit(input).catch((e) => console.error('[audit] log failed:', (e as Error).message, input.kind));
}

export interface ListFilters {
  entity_type?: string;
  entity_id?: string;
  actor_id?: string;
  kind?: string;
  since?: string;     // ISO date
  limit?: number;
}

export async function listAudit(f: ListFilters = {}): Promise<AuditEntry[]> {
  const where: string[] = [];
  const vals: any[] = [];
  const add = (col: string, val: unknown) => {
    if (val !== undefined && val !== null && val !== '') {
      vals.push(val); where.push(`${col} = $${vals.length}`);
    }
  };
  add('entity_type', f.entity_type);
  add('entity_id', f.entity_id);
  add('actor_id', f.actor_id);
  add('kind', f.kind);
  if (f.since) {
    vals.push(f.since); where.push(`created_at >= $${vals.length}`);
  }
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
  vals.push(limit);
  const sql = `
    SELECT id, created_at, kind, entity_type, entity_id,
           actor_id, actor_label, actor_role, before, after, metadata
      FROM audit_log
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC
     LIMIT $${vals.length}`;
  const r = await query<AuditEntry>(sql, vals);
  return r.rows;
}
