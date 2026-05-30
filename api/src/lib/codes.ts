import { randomBytes, randomInt } from 'node:crypto';

// Unambiguous alphabet (no 0/O, 1/I) for printed vouchers.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate a voucher code like ABCD-2345-WXYZ with an optional prefix. */
export function voucherCode(prefix = '', groups = 3, groupLen = 4): string {
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = '';
    for (let i = 0; i < groupLen; i++) {
      s += ALPHABET[randomInt(ALPHABET.length)];
    }
    parts.push(s);
  }
  const body = parts.join('-');
  return prefix ? `${prefix.toUpperCase()}-${body}` : body;
}

/** Sequential-ish, human-friendly invoice number: INV-YYYYMM-XXXXXX */
export function invoiceNumber(date = new Date()): string {
  const ym = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return `INV-${ym}-${rand}`;
}

/** Credit-note number: CN-YYYYMM-XXXXXX */
export function creditNoteNumber(date = new Date()): string {
  const ym = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return `CN-${ym}-${rand}`;
}
