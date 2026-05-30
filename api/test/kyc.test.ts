import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createSubscriber, getSubscriber } from '../src/domains/subscribers/service.js';
import { uploadDocument, listForSubscriber, downloadDocument, review } from '../src/domains/kyc/service.js';

const tag = Date.now().toString().slice(-7);

afterAll(async () => { await pool.end(); });

describe('KYC', () => {
  it('uploads a document, stores it, and moves subscriber to pending', async () => {
    const sub = await createSubscriber({ full_name: 'KYC User', phone: `9${tag}01` });
    const content = Buffer.from('fake-id-image-bytes').toString('base64');
    const doc = await uploadDocument({ subscriberId: sub.id, docType: 'id_card', filename: 'id front.png', contentBase64: content });
    expect(doc.status).toBe('pending');
    expect(doc.size_bytes).toBe(19);
    expect(doc.filename).toBe('id_front.png'); // sanitized

    const fresh = await getSubscriber(sub.id);
    expect(fresh.kyc_status).toBe('pending');

    const list = await listForSubscriber(sub.id);
    expect(list).toHaveLength(1);

    const dl = await downloadDocument(doc.id);
    expect(dl.buffer.toString('utf8')).toBe('fake-id-image-bytes');
  });

  it('verifying a document marks the subscriber verified', async () => {
    const sub = await createSubscriber({ full_name: 'KYC Verify', phone: `9${tag}02` });
    const doc = await uploadDocument({ subscriberId: sub.id, docType: 'passport', filename: 'p.jpg', contentBase64: Buffer.from('x').toString('base64') });
    await review(doc.id, 'verified', 'looks good');
    const fresh = await getSubscriber(sub.id);
    expect(fresh.kyc_status).toBe('verified');
  });

  it('rejects empty uploads', async () => {
    const sub = await createSubscriber({ full_name: 'KYC Empty', phone: `9${tag}03` });
    await expect(uploadDocument({ subscriberId: sub.id, docType: 'other', filename: 'e.bin', contentBase64: '' }))
      .rejects.toMatchObject({ status: 400 });
  });
});
