/**
 * Network monitoring queries. Reads live state from radacct (RADIUS
 * accounting — populated by MikroTik on every PPPoE/hotspot session)
 * and the routers table (WireGuard handshake freshness updated every
 * 30s by pollVpsHandshakes).
 *
 * The /network admin page calls these to render per-router cards,
 * a live-sessions table, and a top-consumers ranking. Historical
 * bandwidth charts use router_metrics (sampled by the worker).
 *
 * Cost note: radacct can get big on a busy router. Every query here
 * is bounded by acctstoptime IS NULL (live sessions only) or a time
 * window, so they all stay sub-second even at millions of historical
 * session rows.
 */
import { query } from '../../db/pool.js';

export interface RouterStatus {
  id: string;
  name: string;
  wg_tunnel_ip: string | null;
  last_handshake_at: string | null;
  wg_up: boolean;             // last handshake < 3 minutes old
  active_sessions: number;
  pppoe_sessions: number;
  hotspot_sessions: number;
  // Bytes/sec averaged over the gap between the two most recent metrics samples.
  // Null when there are fewer than 2 samples (just-deployed routers).
  rate_bps_in: number | null;
  rate_bps_out: number | null;
  // Last sample's running totals — useful for a "data today" headline.
  total_bytes_in: number;
  total_bytes_out: number;
}

/** One row per managed router. Used by the /network page header cards. */
export async function routerStatus(): Promise<RouterStatus[]> {
  const r = await query<any>(
    `WITH live AS (
       SELECT host(nasipaddress) AS nas_ip,
              COUNT(*)::int AS active_sessions,
              COUNT(*) FILTER (WHERE servicetype = 'Framed-User')::int AS pppoe_sessions,
              COUNT(*) FILTER (WHERE servicetype = 'Login-User'  OR servicetype IS NULL)::int AS hotspot_sessions,
              COALESCE(SUM(acctinputoctets), 0)::bigint  AS bytes_in,
              COALESCE(SUM(acctoutputoctets), 0)::bigint AS bytes_out
         FROM radacct
        WHERE acctstoptime IS NULL
        GROUP BY host(nasipaddress)
     ),
     latest AS (
       SELECT DISTINCT ON (router_id) router_id, sampled_at,
              total_bytes_in, total_bytes_out
         FROM router_metrics
        ORDER BY router_id, sampled_at DESC
     ),
     prev AS (
       SELECT m.router_id, m.sampled_at, m.total_bytes_in, m.total_bytes_out
         FROM router_metrics m
         JOIN latest l ON l.router_id = m.router_id AND l.sampled_at > m.sampled_at
        ORDER BY m.router_id, m.sampled_at DESC
        LIMIT 1000
     )
     SELECT r.id, r.name, r.wg_tunnel_ip, r.last_handshake_at,
            (r.last_handshake_at IS NOT NULL AND r.last_handshake_at > now() - interval '3 minutes') AS wg_up,
            COALESCE(live.active_sessions, 0)  AS active_sessions,
            COALESCE(live.pppoe_sessions, 0)   AS pppoe_sessions,
            COALESCE(live.hotspot_sessions, 0) AS hotspot_sessions,
            COALESCE(latest.total_bytes_in, 0)  AS total_bytes_in,
            COALESCE(latest.total_bytes_out, 0) AS total_bytes_out,
            CASE WHEN p.sampled_at IS NOT NULL AND latest.sampled_at > p.sampled_at THEN
              GREATEST(0,
                (latest.total_bytes_in - p.total_bytes_in)::float
                / EXTRACT(EPOCH FROM (latest.sampled_at - p.sampled_at))
              )::bigint
            END AS rate_bps_in,
            CASE WHEN p.sampled_at IS NOT NULL AND latest.sampled_at > p.sampled_at THEN
              GREATEST(0,
                (latest.total_bytes_out - p.total_bytes_out)::float
                / EXTRACT(EPOCH FROM (latest.sampled_at - p.sampled_at))
              )::bigint
            END AS rate_bps_out
       FROM routers r
       LEFT JOIN live    ON live.nas_ip   = r.wg_tunnel_ip
       LEFT JOIN latest  ON latest.router_id = r.id
       LEFT JOIN LATERAL (
         SELECT * FROM router_metrics
          WHERE router_id = r.id AND sampled_at < latest.sampled_at
          ORDER BY sampled_at DESC LIMIT 1
       ) p ON true
       WHERE r.wg_tunnel_ip IS NOT NULL
       ORDER BY r.name`
  );
  return r.rows.map((row: any) => ({
    ...row,
    active_sessions: Number(row.active_sessions),
    pppoe_sessions: Number(row.pppoe_sessions),
    hotspot_sessions: Number(row.hotspot_sessions),
    total_bytes_in: Number(row.total_bytes_in),
    total_bytes_out: Number(row.total_bytes_out),
    rate_bps_in: row.rate_bps_in === null ? null : Number(row.rate_bps_in),
    rate_bps_out: row.rate_bps_out === null ? null : Number(row.rate_bps_out),
  }));
}

export interface LiveSession {
  username: string | null;
  framed_ip: string | null;
  nas_ip: string | null;
  router_name: string | null;
  service_type: string | null;
  acctstarttime: string | null;
  uptime_sec: number;
  bytes_in: number;
  bytes_out: number;
  customer_name: string | null;
  account_number: string | null;
}

/** Live PPPoE + hotspot sessions across all (or a single) router. */
export async function liveSessions(routerId?: string, limit = 200): Promise<LiveSession[]> {
  const cap = Math.min(Math.max(limit, 1), 1000);
  const args: any[] = [cap];
  let where = `WHERE a.acctstoptime IS NULL`;
  if (routerId) {
    args.push(routerId);
    where += ` AND r.id = $${args.length}`;
  }
  const r = await query<any>(
    `SELECT a.username,
            host(a.framedipaddress) AS framed_ip,
            host(a.nasipaddress)    AS nas_ip,
            r.name                  AS router_name,
            a.servicetype           AS service_type,
            a.acctstarttime,
            GREATEST(0, EXTRACT(EPOCH FROM (now() - a.acctstarttime))::int) AS uptime_sec,
            COALESCE(a.acctinputoctets, 0)::bigint  AS bytes_in,
            COALESCE(a.acctoutputoctets, 0)::bigint AS bytes_out,
            c.full_name      AS customer_name,
            c.account_number AS account_number
       FROM radacct a
       LEFT JOIN routers r   ON r.wg_tunnel_ip = host(a.nasipaddress)
       LEFT JOIN services s  ON s.username = a.username
       LEFT JOIN customers c ON c.id = s.customer_id
       ${where}
       ORDER BY (COALESCE(a.acctinputoctets,0) + COALESCE(a.acctoutputoctets,0)) DESC NULLS LAST
       LIMIT $1`,
    args
  );
  return r.rows.map((row: any) => ({
    ...row,
    uptime_sec: Number(row.uptime_sec),
    bytes_in:   Number(row.bytes_in),
    bytes_out:  Number(row.bytes_out),
  }));
}

export interface TopConsumer {
  username: string;
  customer_name: string | null;
  account_number: string | null;
  bytes_total: number;
  session_count: number;
}

/** Top bandwidth consumers in the last N minutes. Reads radacct for any
 *  session active in the window (including ones that ended in the window). */
export async function topConsumers(windowMinutes = 60, limit = 20): Promise<TopConsumer[]> {
  const cap = Math.min(Math.max(limit, 1), 200);
  const r = await query<any>(
    `SELECT a.username,
            c.full_name      AS customer_name,
            c.account_number AS account_number,
            COALESCE(SUM(a.acctinputoctets + a.acctoutputoctets), 0)::bigint AS bytes_total,
            COUNT(*)::int AS session_count
       FROM radacct a
       LEFT JOIN services s  ON s.username = a.username
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE a.username IS NOT NULL
        AND (a.acctstoptime IS NULL OR a.acctstoptime > now() - ($1 || ' minutes')::interval)
        AND a.acctstarttime > now() - ($1 || ' minutes')::interval - interval '1 day'
      GROUP BY a.username, c.full_name, c.account_number
      ORDER BY bytes_total DESC
      LIMIT $2`,
    [String(windowMinutes), cap]
  );
  return r.rows.map((row: any) => ({
    ...row,
    bytes_total: Number(row.bytes_total),
    session_count: Number(row.session_count),
  }));
}

export interface MetricsSample {
  sampled_at: string;
  total_bytes_in: number;
  total_bytes_out: number;
  active_sessions: number;
  wg_up: boolean;
  // Derived bytes/sec from this sample vs the prior one (null on first row).
  rate_bps_in: number | null;
  rate_bps_out: number | null;
}

/** Historical bandwidth chart data for one router. Default last 6 hours. */
export async function routerHistory(routerId: string, hours = 6): Promise<MetricsSample[]> {
  const r = await query<any>(
    `SELECT sampled_at,
            total_bytes_in, total_bytes_out,
            active_sessions, wg_up,
            LAG(sampled_at)      OVER w AS prev_at,
            LAG(total_bytes_in)  OVER w AS prev_in,
            LAG(total_bytes_out) OVER w AS prev_out
       FROM router_metrics
      WHERE router_id = $1
        AND sampled_at > now() - ($2 || ' hours')::interval
      WINDOW w AS (ORDER BY sampled_at)
      ORDER BY sampled_at`,
    [routerId, String(hours)]
  );
  return r.rows.map((row: any) => {
    let rate_bps_in: number | null = null;
    let rate_bps_out: number | null = null;
    if (row.prev_at) {
      const gap = (new Date(row.sampled_at).getTime() - new Date(row.prev_at).getTime()) / 1000;
      if (gap > 0) {
        rate_bps_in  = Math.max(0, (Number(row.total_bytes_in)  - Number(row.prev_in))  / gap);
        rate_bps_out = Math.max(0, (Number(row.total_bytes_out) - Number(row.prev_out)) / gap);
      }
    }
    return {
      sampled_at: row.sampled_at,
      total_bytes_in:  Number(row.total_bytes_in),
      total_bytes_out: Number(row.total_bytes_out),
      active_sessions: Number(row.active_sessions),
      wg_up:           Boolean(row.wg_up),
      rate_bps_in, rate_bps_out,
    };
  });
}

/** One snapshot row per router. Called by the sampler worker on its tick. */
export async function captureSample(): Promise<{ inserted: number }> {
  const r = await query(
    `INSERT INTO router_metrics
       (router_id, total_bytes_in, total_bytes_out,
        active_sessions, pppoe_sessions, hotspot_sessions, wg_up)
     SELECT r.id,
            COALESCE(SUM(a.acctinputoctets), 0)::bigint,
            COALESCE(SUM(a.acctoutputoctets), 0)::bigint,
            COUNT(a.*)::int,
            COUNT(a.*) FILTER (WHERE a.servicetype = 'Framed-User')::int,
            COUNT(a.*) FILTER (WHERE a.servicetype = 'Login-User' OR a.servicetype IS NULL)::int,
            (r.last_handshake_at IS NOT NULL AND r.last_handshake_at > now() - interval '3 minutes')
       FROM routers r
       LEFT JOIN radacct a
         ON host(a.nasipaddress) = r.wg_tunnel_ip
        AND a.acctstoptime IS NULL
       WHERE r.wg_tunnel_ip IS NOT NULL
       GROUP BY r.id, r.last_handshake_at`
  );
  return { inserted: r.rowCount ?? 0 };
}
