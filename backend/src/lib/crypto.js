// PII encryption (AES-256-GCM), keyed lookup hashes, and secure random
// codes. Section 10: PII encrypted at rest with AES-256.

import crypto from 'node:crypto';
import { config } from '../config.js';

function deriveKey(b64, label) {
  if (b64) {
    const key = Buffer.from(b64, 'base64');
    if (key.length === 32) return key;
    // Host-generated secrets (e.g. Render generateValue) may not be exactly
    // 32 base64 bytes; derive a 256-bit key from any high-entropy value.
    if (b64.length < 32) throw new Error(`${label} must be at least 32 characters of random data`);
    return crypto.createHash('sha256').update(`${label}:${b64}`).digest();
  }
  // Development/test only (validateConfig blocks this in production).
  return crypto.createHash('sha256').update(`dev-${label}`).digest();
}

const encKey = deriveKey(config.piiEncryptionKey, 'PII_ENCRYPTION_KEY');
const hmacKey = deriveKey(config.lookupHmacKey, 'LOOKUP_HMAC_KEY');

const VERSION = 1;

// Layout: [version:1][iv:12][tag:16][ciphertext]
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decryptBuffer(blob) {
  if (!blob) return null;
  if (blob[0] !== VERSION) throw new Error('unknown ciphertext version');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

export function decrypt(blob) {
  const buf = decryptBuffer(blob);
  return buf === null ? null : buf.toString('utf8');
}

export function encryptJson(obj) {
  return encrypt(JSON.stringify(obj));
}

export function decryptJson(blob) {
  const s = decrypt(blob);
  return s === null ? null : JSON.parse(s);
}

// Deterministic keyed hash for lookups (phone numbers, OTP codes).
export function lookupHash(value) {
  return crypto.createHmac('sha256', hmacKey).update(String(value)).digest();
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest();
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomDigits(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) out += crypto.randomInt(0, 10).toString();
  return out;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
