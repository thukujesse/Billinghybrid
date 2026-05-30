import { query, withTransaction } from '../../db/pool.js';
import { config } from '../../config.js';
import { creditNoteNumber } from '../../lib/codes.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { getOrCreateWallet, credit } from '../wallet/service.js';
import { getInvoice } from '../billing/service.js';
import { emit } from '../events/bus.js';

export interface CreditNote {
  id: string;
  number: string;
  subscriber_id: string;
  invoice_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string;
  status: 'issued' | 'applied' | 'void';
  created_at: string;
}

/**
 * Issue a credit note for a subscriber. Optionally tied to an invoice (the
 * amount may not exceed the invoice total). The credit is immediately applied
 * to the subscriber's wallet so it offsets future charges.
 */
export async function issueCreditNote(input: {
  subscriberId: string;
  amountCents: number;
  reason: string;
  invoiceId?: string;
}): Promise<CreditNote> {
  if (input.amountCents <= 0) throw badRequest('amount must be positive');

  if (input.invoiceId) {
    const invoice = await getInvoice(input.invoiceId);
    if (invoice.subscriber_id !== input.subscriberId) {
      throw badRequest('invoice does not belong to this subscriber');
    }
    if (input.amountCents > invoice.total_cents) {
      throw badRequest('credit note cannot exceed the invoice total');
    }
  }

  return withTransaction(async (c) => {
    const r = await c.query<CreditNote>(
      `INSERT INTO credit_notes (number, subscriber_id, invoice_id, amount_cents, currency, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,'applied') RETURNING *`,
      [creditNoteNumber(), input.subscriberId, input.invoiceId ?? null, input.amountCents, config.currency, input.reason]
    );
    const note = r.rows[0];

    const wallet = await getOrCreateWallet('subscriber', input.subscriberId, c);
    await credit(wallet.id, input.amountCents, `Credit note ${note.number}`, { type: 'credit_note', id: note.id }, c);

    await emit('credit_note.issued', { creditNoteId: note.id, subscriberId: input.subscriberId, amount: input.amountCents });
    return note;
  });
}

export async function listCreditNotes(subscriberId?: string): Promise<CreditNote[]> {
  const r = subscriberId
    ? await query<CreditNote>('SELECT * FROM credit_notes WHERE subscriber_id = $1 ORDER BY created_at DESC', [subscriberId])
    : await query<CreditNote>('SELECT * FROM credit_notes ORDER BY created_at DESC LIMIT 200');
  return r.rows;
}

export async function getCreditNote(id: string): Promise<CreditNote> {
  const r = await query<CreditNote>('SELECT * FROM credit_notes WHERE id = $1', [id]);
  if (!r.rows[0]) throw notFound('credit note');
  return r.rows[0];
}
