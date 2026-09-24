import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool, query } from '../src/db.js';
import { decrypt } from '../src/lib/crypto.js';
import { migrate } from '../src/lib/migrate.js';
import { currentStep, hotp } from '../src/lib/totp.js';
import { WORKER_POLICY_SHA256 } from '../src/lib/policy.js';
import { config } from '../src/config.js';
import { sms } from '../src/services/comms.js';
import argon2 from 'argon2';

export const app = createApp();
export const api = () => request(app);

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
  await query(`INSERT INTO services (name, category, fixed_price_paise, duration_minutes, description)
               VALUES ('AC service', 'ac_service', 59900, 60, 'test'), ('Deep clean', 'cleaning', 349900, 240, 'test')`);
  const { rows } = await query(`INSERT INTO cities (name, franchise_operator, franchise_revenue_share_bps)
                                VALUES ('Bengaluru', 'Namma Services LLP', 3000) RETURNING id`);
  await query(`INSERT INTO city_pincodes (pincode, city_id) VALUES ('560001', $1), ('560002', $1)`, [rows[0].id]);
  return rows[0].id;
}

let phoneSeq = 0;
export function nextPhone() {
  phoneSeq += 1;
  return `98${String(Date.now() % 1e5).padStart(5, '0')}${String(phoneSeq).padStart(3, '0')}`;
}

export async function otpLogin(phone, role, extra = { acceptPrivacyPolicy: true }) {
  await api().post('/api/auth/otp/request').send({ phone, role }).expect(200);
  const code = sms.lastDevOtp.get(`+91${phone.slice(-10)}`);
  const res = await api().post('/api/auth/otp/verify').send({ phone, role, code, ...extra });
  return res;
}

export async function customer(name = 'Priya Sharma') {
  const phone = nextPhone();
  const res = await otpLogin(phone, 'customer');
  const token = res.body.accessToken;
  await api().patch('/api/me').set(auth(token)).send({ name }).expect(200);
  const addr = await api().post('/api/addresses').set(auth(token)).send({
    label: 'Home', line1: '12 MG Road, Flat 402', city: 'Bengaluru', pincode: '560001', lat: 12.9716, lng: 77.5946,
  }).expect(201);
  return { token, userId: res.body.user.id, addressId: addr.body.id, phone };
}

export function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

// A tiny valid JPEG header is enough for the content sniffer.
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

export async function onboardedWorker({ approve = true, skill = 'ac_service', pincode = '560001', name = 'Ravi Kumar' } = {}) {
  const phone = nextPhone();
  const res = await otpLogin(phone, 'worker');
  const token = res.body.accessToken;
  await api().post('/api/worker/onboarding').set(auth(token)).send({
    name, skillCategory: skill, serviceAreaPincode: pincode, idType: 'aadhaar', idNumber: '2345 6789 0124',
  }).expect(200);
  for (const docType of ['id_front', 'selfie']) {
    await api().post('/api/worker/kyc/documents').set(auth(token)).field('docType', docType)
      .attach('file', JPEG, { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(201);
  }
  await api().post('/api/worker/payout-account').set(auth(token)).send({
    method: 'bank_account', holderName: name, accountNumber: '123456789012', ifsc: 'HDFC0001234',
  }).expect(200);
  await api().post('/api/worker/policy/accept').set(auth(token)).send({ version: config.policyVersion, sha256: WORKER_POLICY_SHA256, agree: true }).expect(200);
  await api().post('/api/worker/kyc/submit').set(auth(token)).expect(200);
  const { rows } = await query('SELECT w.id FROM workers w JOIN users u ON u.id = w.user_id WHERE u.id = $1', [res.body.user.id]);
  if (approve) await query(`UPDATE workers SET kyc_status = 'approved' WHERE id = $1`, [rows[0].id]);
  return { token, userId: res.body.user.id, workerId: rows[0].id, phone };
}

export const ADMIN_PASSWORD = 'Str0ng!Passw0rd#';

export async function createAdmin(email, permissions) {
  const { rows } = await query(`INSERT INTO users (role, name, email) VALUES ('admin', $1, $2) RETURNING id`, [email.split('@')[0], email]);
  await query('INSERT INTO admin_accounts (user_id, password_hash, permissions) VALUES ($1, $2, $3)',
    [rows[0].id, await argon2.hash(ADMIN_PASSWORD), permissions]);
  return rows[0].id;
}

// Full admin login: password -> TOTP enrolment/verification.
export async function adminLogin(email, { stepOffset = 0 } = {}) {
  const login = await api().post('/api/admin-auth/login').send({ email, password: ADMIN_PASSWORD }).expect(200);
  const pending = login.body.pendingToken;
  if (login.body.stage === 'totp_setup') {
    await api().post('/api/admin-auth/totp/setup').set(auth(pending)).expect(200);
  }
  const { rows } = await query(
    `SELECT a.totp_secret_enc, a.last_totp_step FROM admin_accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1`, [email]);
  const secret = decrypt(rows[0].totp_secret_enc);
  // Use the next unused step (replay protection rejects reused steps).
  let step = currentStep() + stepOffset;
  if (rows[0].last_totp_step !== null && Number(rows[0].last_totp_step) >= step) step = Number(rows[0].last_totp_step) + 1;
  const res = await api().post('/api/admin-auth/totp/verify').set(auth(pending)).send({ code: hotp(secret, step) }).expect(200);
  return res.body.accessToken;
}

export async function paidBooking(c, { daysAhead = 1, hour = 11, serviceName = 'AC service', withWarranty, openToAll = true } = {}) {
  const { rows } = await query('SELECT id FROM services WHERE name = $1', [serviceName]);
  const res = await api().post('/api/bookings').set(auth(c.token)).send({
    serviceId: rows[0].id, addressId: c.addressId, scheduledTime: istSlot(daysAhead, hour), acceptCancellationPolicy: true,
    ...(withWarranty ? { withWarranty: true } : {}),
  }).expect(201);
  const pay = await api().post('/api/payments/mock/checkout').set(auth(c.token)).send({ orderId: res.body.order.orderId }).expect(200);
  await api().post('/api/payments/confirm').set(auth(c.token)).send({
    orderId: res.body.order.orderId, paymentId: pay.body.paymentId, signature: pay.body.signature,
  }).expect(200);
  // Past the featured-professional priority window, so any worker can accept.
  if (openToAll) await query(`UPDATE bookings SET paid_at = now() - interval '1 hour' WHERE id = $1`, [res.body.booking.id]);
  return res.body.booking.id;
}

// `hour`:00 IST, `daysAhead` days from today (IST).
export function istSlot(daysAhead, hour) {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  ist.setUTCDate(ist.getUTCDate() + daysAhead);
  ist.setUTCHours(hour, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 3600_000).toISOString();
}

export const AT_ADDRESS = { lat: 12.9717, lng: 77.5947, accuracyM: 15 };
