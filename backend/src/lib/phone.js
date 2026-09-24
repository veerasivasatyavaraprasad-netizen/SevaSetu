import { badRequest } from './errors.js';

// Normalises Indian mobile numbers to E.164 (+91XXXXXXXXXX).
export function normalizeIndianMobile(input) {
  const digits = String(input || '').replace(/[\s\-()]/g, '');
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  if (!m) throw badRequest('Enter a valid 10-digit Indian mobile number');
  return `+91${m[1]}`;
}
