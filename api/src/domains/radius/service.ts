import { query } from '../../db/pool.js';

export interface RadiusSession {
  id: string;
  username: string;
  nas_ip: string;
  framed_ip: string | null;
  start_time: string;
  session_time: number;
  bytes_in: number;
  bytes_out: number;
  caller_id: string | null;
  active: boolean;
}

/**
 * Active RADIUS sessions: any radacct row that hasn't been closed with an
 * Acct-Stop. Useful for the dashboard "who's online right now" view.
 */
export async function listActiveSessions(): Promise<RadiusSession[]> {
  const r = await query<RadiusSession>(
    `SELECT
       radacctid::text AS id,
       username,
       nasipaddress::text AS nas_ip,
       framedipaddress::text AS framed_ip,
       acctstarttime AS start_time,
       coalesce(acctsessiontime, 0) AS session_time,
       coalesce(acctinputoctets, 0) AS bytes_in,
       coalesce(acctoutputoctets, 0) AS bytes_out,
       callingstationid AS caller_id,
       true AS active
     FROM radacct
     WHERE acctstoptime IS NULL
     ORDER BY acctstarttime DESC
     LIMIT 200`
  );
  return r.rows;
}

/** Recent session history including closed sessions, for an at-a-glance view. */
export async function listRecentSessions(limit = 50): Promise<RadiusSession[]> {
  const r = await query<RadiusSession>(
    `SELECT
       radacctid::text AS id,
       username,
       nasipaddress::text AS nas_ip,
       framedipaddress::text AS framed_ip,
       acctstarttime AS start_time,
       coalesce(acctsessiontime, 0) AS session_time,
       coalesce(acctinputoctets, 0) AS bytes_in,
       coalesce(acctoutputoctets, 0) AS bytes_out,
       callingstationid AS caller_id,
       (acctstoptime IS NULL) AS active
     FROM radacct
     ORDER BY radacctid DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}
