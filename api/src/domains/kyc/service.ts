import { query } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getSubscriber } from '../subscribers/service.js';
import * as storage from '../storage/service.js';
import { emit } from '../events/bus.js';

export type DocType = 'id_card' | 'passport' | 'selfie' | 'other';

export interface KycDocument {
  id: string;
  subscriber_id: string;
  doc_type: DocType;
  storage_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: 'pending' | 'verified' | 'rejected';
  review_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per document

/**
 * Upload a KYC document (base64 payload — keeps the API dependency-free). The
 * file is written to object storage and the subscriber moves to 'pending'.
 */
export async function uploadDocument(input: {
  subscriberId: string;
  docType: DocType;
  filename: string;
  contentBase64: string;
  contentType?: string;
}): Promise<KycDocument> {
  await getSubscriber(input.subscriberId);

  const buffer = Buffer.from(input.contentBase64, 'base64');
  if (buffer.length === 0) throw badRequest('empty file');
  if (buffer.length > MAX_BYTES) throw badRequest('file exceeds 8 MB limit');

  const safeName = input.filename.replace(/[^\w.\-]/g, '_').slice(0, 80);
  const key = `kyc/${input.subscriberId}/${Date.now()}_${safeName}`;
  await storage.put(key, buffer);

  const r = await query<KycDocument>(
    `INSERT INTO kyc_documents (subscriber_id, doc_type, storage_key, filename, content_type, size_bytes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.subscriberId, input.docType, key, safeName, input.contentType ?? 'application/octet-stream', buffer.length]
  );
  await query(`UPDATE subscribers SET kyc_status = 'pending' WHERE id = $1 AND kyc_status != 'verified'`, [input.subscriberId]);
  await emit('kyc.submitted', { subscriberId: input.subscriberId, docId: r.rows[0].id });
  return r.rows[0];
}

export async function listForSubscriber(subscriberId: string): Promise<KycDocument[]> {
  const r = await query<KycDocument>(
    'SELECT * FROM kyc_documents WHERE subscriber_id = $1 ORDER BY created_at DESC',
    [subscriberId]
  );
  return r.rows;
}

export async function getDocument(id: string): Promise<KycDocument> {
  const r = await query<KycDocument>('SELECT * FROM kyc_documents WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('kyc document');
  return r.rows[0];
}

export async function downloadDocument(id: string): Promise<{ buffer: Buffer; doc: KycDocument }> {
  const doc = await getDocument(id);
  return { buffer: await storage.get(doc.storage_key), doc };
}

/**
 * Review a document. Verifying it marks the subscriber verified; rejecting it
 * marks the subscriber rejected. Both are reflected on subscribers.kyc_status.
 */
export async function review(id: string, decision: 'verified' | 'rejected', note?: string): Promise<KycDocument> {
  const doc = await getDocument(id);
  const r = await query<KycDocument>(
    `UPDATE kyc_documents SET status = $2, review_note = $3, reviewed_at = now() WHERE id = $1 RETURNING *`,
    [id, decision, note ?? null]
  );
  await query(`UPDATE subscribers SET kyc_status = $2 WHERE id = $1`, [doc.subscriber_id, decision]);
  await emit('kyc.reviewed', { subscriberId: doc.subscriber_id, docId: id, decision });
  return r.rows[0];
}
