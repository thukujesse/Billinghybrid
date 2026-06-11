/**
 * Advertisements — local ad network for the hotspot platform. Admin CRUD +
 * a public "what should this placement show right now" query (active + within
 * the schedule window + router-targeted) and impression/click counters. Stays
 * tenant-agnostic: DB-per-tenant isolates each ISP's ads.
 */
import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';

export type AdPlacement = 'portal_banner' | 'post_payment' | 'dashboard';
export type AdMediaType = 'image' | 'video';

export interface Ad {
  id: string;
  title: string;
  media_type: AdMediaType;
  media_url: string;
  link_url: string | null;
  placement: AdPlacement;
  target_router_id: string | null;
  weight: number;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  impressions: number;
  clicks: number;
  created_at: string;
  updated_at: string;
}

/** Public, lightweight shape served to the captive portal. */
export interface AdPublic {
  id: string;
  title: string;
  media_type: AdMediaType;
  media_url: string;
  link_url: string | null;
}

/** Admin: every ad (newest first). */
export async function listAds(): Promise<Ad[]> {
  return (await query<Ad>(`SELECT * FROM ads ORDER BY created_at DESC`)).rows;
}

/** Public: the ads that should display for a placement right now — active,
 *  inside the schedule window, and either global or targeted at this router. */
export async function listActiveAds(placement: AdPlacement, routerId?: string): Promise<AdPublic[]> {
  return (await query<AdPublic>(
    `SELECT id, title, media_type, media_url, link_url
       FROM ads
      WHERE placement = $1
        AND active = TRUE
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at   IS NULL OR ends_at   >= now())
        AND (target_router_id IS NULL OR target_router_id = $2)
      ORDER BY weight DESC, created_at DESC
      LIMIT 20`,
    [placement, routerId ?? null]
  )).rows;
}

export interface CreateAdInput {
  title: string;
  media_type?: AdMediaType;
  media_url: string;
  link_url?: string;
  placement?: AdPlacement;
  target_router_id?: string | null;
  weight?: number;
  starts_at?: string | null;
  ends_at?: string | null;
  active?: boolean;
}

export async function createAd(input: CreateAdInput): Promise<Ad> {
  if (!input.title?.trim()) throw badRequest('title required');
  if (!input.media_url?.trim()) throw badRequest('media (image or video URL) required');
  const r = await query<Ad>(
    `INSERT INTO ads (title, media_type, media_url, link_url, placement,
                      target_router_id, weight, starts_at, ends_at, active)
     VALUES ($1, COALESCE($2,'image'), $3, $4, COALESCE($5,'portal_banner'),
             $6, COALESCE($7,1), $8, $9, COALESCE($10, TRUE))
     RETURNING *`,
    [input.title.trim(), input.media_type ?? null, input.media_url, input.link_url ?? null,
     input.placement ?? null, input.target_router_id ?? null, input.weight ?? null,
     input.starts_at ?? null, input.ends_at ?? null, input.active ?? null]
  );
  return r.rows[0];
}

export async function updateAd(id: string, input: Partial<CreateAdInput>): Promise<Ad> {
  const sets: string[] = [];
  const vals: any[] = [];
  const cols: Array<keyof CreateAdInput> = [
    'title', 'media_type', 'media_url', 'link_url', 'placement',
    'target_router_id', 'weight', 'starts_at', 'ends_at', 'active',
  ];
  for (const c of cols) {
    if (input[c] === undefined) continue;
    vals.push(input[c]);
    sets.push(`${c} = $${vals.length}`);
  }
  if (sets.length === 0) {
    const r = await query<Ad>(`SELECT * FROM ads WHERE id=$1`, [id]);
    if (!r.rows[0]) throw notFound('ad');
    return r.rows[0];
  }
  sets.push(`updated_at = now()`);
  vals.push(id);
  const r = await query<Ad>(`UPDATE ads SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
  if (!r.rows[0]) throw notFound('ad');
  return r.rows[0];
}

export async function deleteAd(id: string): Promise<void> {
  await query(`DELETE FROM ads WHERE id=$1`, [id]);
}

/** Fire-and-forget counters from the portal. Cheap atomic increments. */
export async function recordImpression(id: string): Promise<void> {
  await query(`UPDATE ads SET impressions = impressions + 1 WHERE id=$1`, [id]);
}
export async function recordClick(id: string): Promise<void> {
  await query(`UPDATE ads SET clicks = clicks + 1 WHERE id=$1`, [id]);
}
