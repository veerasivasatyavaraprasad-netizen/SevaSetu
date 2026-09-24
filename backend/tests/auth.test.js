import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { sms } from '../src/services/comms.js';
import {
  ADMIN_PASSWORD, adminLogin, api, auth, createAdmin, nextPhone, otpLogin, resetDb,
} from './helpers.js';

beforeAll(resetDb);

describe('phone OTP login (Section 5.1/5.2)', () => {
  it('creates a customer after OTP and requires privacy consent', async () => {
    const phone = nextPhone();
    await api().post('/api/auth/otp/request').send({ phone, role: 'customer' }).expect(200);
    const code = sms.lastDevOtp.get(`+91${phone}`);
    const noConsent = await api().post('/api/auth/otp/verify').send({ phone, role: 'customer', code });
    expect(noConsent.status).toBe(400);
    const ok = await api().post('/api/auth/otp/verify').send({ phone, role: 'customer', code, acceptPrivacyPolicy: true }).expect(200);
    expect(ok.body.isNewUser).toBe(true);
    expect(ok.body.next).toBe('home');
    const { rows } = await query('SELECT phone_enc, phone_last4 FROM users WHERE id = $1', [ok.body.user.id]);
    expect(rows[0].phone_enc.toString('latin1')).not.toContain(phone);  // encrypted at rest
    expect(rows[0].phone_last4).toBe(phone.slice(-4));
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });

  it('routes new workers to onboarding', async () => {
    const res = await otpLogin(nextPhone(), 'worker');
    expect(res.body.next).toBe('onboarding');
    expect(res.body.kycStatus).toBe('not_submitted');
  });

  it('limits OTP requests to 3 per 10 minutes per number', async () => {
    const phone = nextPhone();
    for (let i = 0; i < 3; i += 1) await api().post('/api/auth/otp/request').send({ phone, role: 'customer' }).expect(200);
    await api().post('/api/auth/otp/request').send({ phone, role: 'customer' }).expect(429);
  });

  it('locks an OTP after 5 wrong attempts', async () => {
    const phone = nextPhone();
    await api().post('/api/auth/otp/request').send({ phone, role: 'customer' }).expect(200);
    const code = sms.lastDevOtp.get(`+91${phone}`);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/auth/otp/verify').send({ phone, role: 'customer', code: wrong, acceptPrivacyPolicy: true }).expect(401);
    }
    await api().post('/api/auth/otp/verify').send({ phone, role: 'customer', code, acceptPrivacyPolicy: true }).expect(429);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const res = await otpLogin(nextPhone(), 'customer');
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const r1 = await api().post('/api/auth/refresh').set('Cookie', cookie).expect(200);
    const cookie2 = r1.headers['set-cookie'][0].split(';')[0];
    // Replay the old token: rejected, and the new one dies with it.
    await api().post('/api/auth/refresh').set('Cookie', cookie).expect(401);
    await api().post('/api/auth/refresh').set('Cookie', cookie2).expect(401);
  });

  it('never trusts the role claim alone: a customer token cannot reach worker or admin APIs', async () => {
    const res = await otpLogin(nextPhone(), 'customer');
    await api().get('/api/worker/me').set(auth(res.body.accessToken)).expect(403);
    await api().get('/api/admin/dashboard').set(auth(res.body.accessToken)).expect(403);
  });

  it('logout revokes the session server-side', async () => {
    const res = await otpLogin(nextPhone(), 'customer');
    await api().post('/api/auth/logout').set(auth(res.body.accessToken)).expect(200);
    await api().get('/api/me').set(auth(res.body.accessToken)).expect(401);
  });

  it('keeps the service catalogue public', async () => {
    const res = await api().get('/api/services').expect(200);
    expect(res.body.services.length).toBeGreaterThan(0);
  });

  it('rejects cross-origin state-changing requests', async () => {
    await api().post('/api/auth/refresh').set('Origin', 'https://evil.example').expect(403);
  });
});

describe('admin login (Section 5.3)', () => {
  it('requires 2FA enrolment and TOTP; pending sessions cannot use the API', async () => {
    await createAdmin('ops@example.com', ['reports.view']);
    const login = await api().post('/api/admin-auth/login').send({ email: 'ops@example.com', password: ADMIN_PASSWORD }).expect(200);
    expect(login.body.stage).toBe('totp_setup');
    await api().get('/api/admin/dashboard').set(auth(login.body.pendingToken)).expect(401);
    const token = await adminLogin('ops@example.com');
    await api().get('/api/admin/dashboard').set(auth(token)).expect(200);
  });

  it('logs every attempt and locks after 5 failures', async () => {
    await createAdmin('lock@example.com', ['reports.view']);
    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/admin-auth/login').send({ email: 'lock@example.com', password: 'wrong-password-1A!' }).expect(401);
    }
    const locked = await api().post('/api/admin-auth/login').send({ email: 'lock@example.com', password: ADMIN_PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.message).toMatch(/locked/);
    const { rows } = await query(`SELECT count(*)::int AS n FROM admin_login_attempts WHERE email = 'lock@example.com'`);
    expect(rows[0].n).toBe(6);
  });

  it('expires admin sessions after 2 hours of inactivity', async () => {
    await createAdmin('idle@example.com', ['reports.view']);
    const token = await adminLogin('idle@example.com');
    await query(`UPDATE sessions SET last_seen_at = now() - interval '121 minutes'
                  WHERE user_id = (SELECT id FROM users WHERE email = 'idle@example.com') AND revoked_at IS NULL`);
    await api().get('/api/admin/dashboard').set(auth(token)).expect(401);
  });

  it('does not reveal whether an email exists', async () => {
    const a = await api().post('/api/admin-auth/login').send({ email: 'nobody@example.com', password: 'x' });
    const b = await api().post('/api/admin-auth/login').send({ email: 'ops@example.com', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
  });
});
