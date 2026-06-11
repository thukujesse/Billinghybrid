/**
 * Leads — the pre-customer funnel (Network Twin Phase 2). A lead is a prospect
 * captured before installation (demand mapping). The state machine advances
 * lead -> survey -> scheduled -> installing -> active; at 'active' the lead
 * converts into a real customer + service (convertLead) and enters the twin.
 */
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { createCustomer } from '../customers/service.js';

export type LeadStage = 'lead' | 'survey' | 'scheduled' | 'installing' | 'active' | 'on_hold' | 'lost';
const STAGES: LeadStage[] = ['lead', 'survey', 'scheduled', 'installing', 'active', 'on_hold', 'lost'];

export interface Lead {
  id: string; name: string; phone: string | null; email: string | null;
  stage: LeadStage; service_interest: string | null; source: string | null;
  landmark: string | null; notes: string | null;
  latitude: number | null; longitude: number | null;
  converted_customer_id: string | null;
  created_at: string; updated_at: string;
}

export async function listLeads(stage?: string, limit = 500): Promise<Lead[]> {
  if (stage && STAGES.includes(stage as LeadStage)) {
    return (await query<Lead>(
      `SELECT * FROM leads WHERE stage = $1 ORDER BY created_at DESC LIMIT $2`, [stage, limit]
    )).rows;
  }
  return (await query<Lead>(`SELECT * FROM leads ORDER BY created_at DESC LIMIT $1`, [limit])).rows;
}

/** Counts per stage — drives the funnel header. */
export async function leadStats(): Promise<Record<string, number>> {
  const r = await query<{ stage: string; n: number }>(
    `SELECT stage, COUNT(*)::int AS n FROM leads GROUP BY stage`
  );
  const out: Record<string, number> = {};
  for (const s of STAGES) out[s] = 0;
  for (const row of r.rows) out[row.stage] = row.n;
  return out;
}

/** Located leads for the map's "Leads" layer (translucent prospect pins). */
export async function listLeadsForMap(): Promise<Array<Pick<Lead, 'id' | 'name' | 'phone' | 'stage' | 'service_interest' | 'latitude' | 'longitude'>>> {
  return (await query(
    `SELECT id, name, phone, stage, service_interest, latitude, longitude
       FROM leads
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND stage <> 'active' AND stage <> 'lost'`
  )).rows;
}

export async function createLead(input: {
  name: string; phone?: string; email?: string; service_interest?: string;
  source?: string; landmark?: string; notes?: string;
  latitude?: number; longitude?: number;
}, by?: string): Promise<Lead> {
  if (!input.name?.trim()) throw badRequest('name required');
  const r = await query<Lead>(
    `INSERT INTO leads (name, phone, email, service_interest, source, landmark, notes, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [input.name.trim(), input.phone ?? null, input.email ?? null, input.service_interest ?? null,
     input.source ?? null, input.landmark ?? null, input.notes ?? null,
     input.latitude ?? null, input.longitude ?? null]
  );
  const lead = r.rows[0];
  await query(`INSERT INTO lead_events (lead_id, to_stage, note, created_by) VALUES ($1,'lead','created',$2)`,
    [lead.id, by ?? 'admin']);
  return lead;
}

export async function setLeadLocation(id: string, lat: number, lng: number): Promise<void> {
  const r = await query(`UPDATE leads SET latitude=$2, longitude=$3, updated_at=now() WHERE id=$1`, [id, lat, lng]);
  if (!r.rowCount) throw notFound('lead');
}

export async function transitionLead(id: string, toStage: LeadStage, note?: string, by?: string): Promise<Lead> {
  if (!STAGES.includes(toStage)) throw badRequest('invalid stage');
  const cur = (await query<{ stage: LeadStage }>(`SELECT stage FROM leads WHERE id=$1`, [id])).rows[0];
  if (!cur) throw notFound('lead');
  if (toStage === 'active') throw badRequest('use convert to move a lead to active');
  const r = await query<Lead>(`UPDATE leads SET stage=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, toStage]);
  await query(`INSERT INTO lead_events (lead_id, from_stage, to_stage, note, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [id, cur.stage, toStage, note ?? null, by ?? 'admin']);
  return r.rows[0];
}

export async function deleteLead(id: string): Promise<void> {
  await query(`DELETE FROM leads WHERE id=$1`, [id]);
}

/**
 * Convert a lead into a real customer at the 'active' boundary: create the
 * customer, copy the lead's GPS into customer_locations (so they enter the
 * twin), and mark the lead active + linked. Service provisioning stays in the
 * normal customer flow — operator adds the service next. Idempotent-ish:
 * refuses if already converted.
 */
export async function convertLead(id: string, by?: string): Promise<{ customerId: string }> {
  return withTransaction(async (c) => {
    const lead = (await c.query<Lead>(`SELECT * FROM leads WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!lead) throw notFound('lead');
    if (lead.converted_customer_id) return { customerId: lead.converted_customer_id };

    const customer = await createCustomer({
      full_name: lead.name,
      phone: lead.phone ?? undefined,
      email: lead.email ?? undefined,
      address: lead.landmark ?? undefined,
      notes: lead.notes ? `From lead: ${lead.notes}` : 'Converted from lead',
    });

    if (lead.latitude != null && lead.longitude != null) {
      await c.query(
        `INSERT INTO customer_locations (customer_id, latitude, longitude, source)
         VALUES ($1,$2,$3,'lead')
         ON CONFLICT (customer_id) DO UPDATE SET latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude, source='lead', updated_at=now()`,
        [customer.id, lead.latitude, lead.longitude]
      );
    }
    await c.query(`UPDATE leads SET stage='active', converted_customer_id=$2, updated_at=now() WHERE id=$1`, [id, customer.id]);
    await c.query(`INSERT INTO lead_events (lead_id, from_stage, to_stage, note, created_by) VALUES ($1,$2,'active','converted to customer',$3)`,
      [id, lead.stage, by ?? 'admin']);
    return { customerId: customer.id };
  });
}
