// Government ID format validation for KYC.

// Verhoeff checksum, used by Aadhaar numbers.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(num) {
  let c = 0;
  const digits = num.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i += 1) c = D[c][P[i % 8][digits[i]]];
  return c === 0;
}

export function normalizeIdNumber(type, raw) {
  const v = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  switch (type) {
    case 'aadhaar':
      // 12 digits, cannot start with 0 or 1, Verhoeff check digit.
      return /^[2-9]\d{11}$/.test(v) && verhoeffValid(v) ? v : null;
    case 'pan':
      return /^[A-Z]{5}\d{4}[A-Z]$/.test(v) ? v : null;
    case 'voter_id':
      return /^[A-Z]{3}\d{7}$/.test(v) ? v : null;
    case 'driving_licence':
      return /^[A-Z]{2}\d{2}\d{4}\d{7}$/.test(v) || /^[A-Z]{2}\d{13}$/.test(v) ? v : null;
    default:
      return null;
  }
}

// Detect file type from content, not from the client's claimed MIME type.
export function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
