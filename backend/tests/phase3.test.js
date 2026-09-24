import { beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { sms } from '../src/services/comms.js';
import { runJob } from '../src/services/jobs.js';
import {
  AT_ADDRESS, adminLogin, api, auth, createAdmin, customer, istSlot, nextPhone, onboardedWorker, paidBooking, resetDb,
} from './helpers.js';

let blrId;
let ops;
let fin;

beforeAll(async () => {
  blrId = await resetDb();
  await createAdmin('ops3@example.com', ['reports.view', 'bookings.manage', 'workers.kyc', 'disputes.manage', 'catalog.manage',
    'cities.manage', 'ads.manage', 'admins.manage']);
  await createAdmin('fin3@example.com', ['changes.approve', 'refunds.approve']);
  ops = await adminLogin('ops3@example.com');
  fin = await adminLogin('fin3@example.com');
});

async function completeJob(c, w, id) {
  await api().post(`/api/worker/jobs/${id}/accept`).set(auth(w.token)).expect(200);
  await query(`UPDATE bookings SET scheduled_time = now() + interval '30 minutes' WHERE id = $1`, [id]);
  await api().post(`/api/worker/jobs/${id}/checkin`).set(auth(w.token)).send(AT_ADDRESS).expect(200);
  const v = await api().get(`/api/bookings/${id}`).set(auth(c.token)).expect(200);
  await api().post(`/api/worker/jobs/${id}/complete`).set(auth(w.token)).send({ otp: v.body.booking.completionOtp, ...AT_ADDRESS }).expect(200);
}

describe('cities and serviceability', () => {
  it('refuses bookings and worker areas outside served PIN codes', async () => {
    const c = await customer();
    const addr = await api().post('/api/addresses').set(auth(c.token)).send({
      label: 'Mumbai', line1: '1 Marine Drive', city: 'Mumbai', pincode: '400001', lat: 18.94, lng: 72.82,
    }).expect(201);
    const { rows } = await query(`SELECT id FROM services LIMIT 1`);
    const res = await api().post('/api/bookings').set(auth(c.token)).send({
      serviceId: rows[0].id, addressId: addr.body.id, scheduledTime: istSlot(1, 11), acceptCancellationPolicy: true,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/don't serve PIN code 400001/);
    const s = await api().get('/api/serviceability?pincode=560001').expect(200);
    expect(s.body).toEqual({ serviceable: true, city: 'Bengaluru' });
  });

  it('admins manage cities and PIN codes; a PIN belongs to one city', async () => {
    const city = await api().post('/api/admin/cities').set(auth(ops)).send({ name: 'Mysuru', franchiseOperator: 'Mysuru Homes', franchiseRevenueSharePercent: 25 }).expect(201);
    await api().post(`/api/admin/cities/${city.body.city.id}/pincodes`).set(auth(ops)).send({ add: ['570001'] }).expect(200);
    await api().post(`/api/admin/cities/${city.body.city.id}/pincodes`).set(auth(ops)).send({ add: ['560001'] }).expect(409);
  });
});

describe('featured listings (priority visibility)', () => {
  it('featured workers see and accept new jobs first', async () => {
    const plan = await api().post('/api/admin/featured-plans').set(auth(ops)).send({ name: 'Week', days: 7, pricePaise: 19900 }).expect(201);
    const regular = await onboardedWorker();
    const star = await onboardedWorker({ name: 'Star Worker' });
    const buy = await api().post('/api/worker/featured').set(auth(star.token)).send({ planId: plan.body.plan.id }).expect(201);
    const pay = await api().post('/api/payments/mock/checkout').set(auth(star.token)).send({ orderId: buy.body.order.orderId }).expect(200);
    await api().post('/api/payments/confirm').set(auth(star.token)).send({ orderId: buy.body.order.orderId, ...pay.body }).expect(200);
    const f = await api().get('/api/worker/featured').set(auth(star.token)).expect(200);
    expect(f.body.active).toHaveLength(1);

    const c = await customer();
    const id = await paidBooking(c, { openToAll: false, hour: 17 });
    const openRegular = await api().get('/api/worker/jobs/open').set(auth(regular.token)).expect(200);
    expect(openRegular.body.jobs.find((j) => j.id === id)).toBeUndefined();
    expect(openRegular.body.hiddenInPriorityWindow).toBeGreaterThan(0);
    await api().post(`/api/worker/jobs/${id}/accept`).set(auth(regular.token)).expect(409);
    const openStar = await api().get('/api/worker/jobs/open').set(auth(star.token)).expect(200);
    expect(openStar.body.jobs.find((j) => j.id === id)).toBeTruthy();
    await api().post(`/api/worker/jobs/${id}/accept`).set(auth(star.token)).expect(200);
  });

  it('a customer cannot pay for a worker\'s featured order', async () => {
    const w = await onboardedWorker();
    const { rows } = await query('SELECT id FROM featured_plans LIMIT 1');
    const buy = await api().post('/api/worker/featured').set(auth(w.token)).send({ planId: rows[0].id }).expect(201);
    const c = await customer();
    await api().post('/api/payments/mock/checkout').set(auth(c.token)).send({ orderId: buy.body.order.orderId }).expect(404);
  });
});

describe('30-day warranty add-on', () => {
  it('charges the fee to the platform, allows a claim after 7 days, and resolves with a free verified revisit', async () => {
    const { rows: svc } = await query(`UPDATE services SET warranty_fee_paise = 4900 WHERE name = 'AC service' RETURNING id`);
    const c = await customer();
    const w = await onboardedWorker();
    const q = await api().post('/api/bookings/quote').set(auth(c.token)).send({ serviceId: svc[0].id, scheduledTime: istSlot(2, 11), withWarranty: true }).expect(200);
    expect(q.body.quote.total).toBe(59900 + 4900);

    const id = await paidBooking(c, { daysAhead: 2, withWarranty: true });
    await completeJob(c, w, id);
    await api().post(`/api/bookings/${id}/confirm`).set(auth(c.token)).expect(200);
    const { rows: b } = await query('SELECT amount, commission_amount, worker_payout, warranty_until FROM bookings WHERE id = $1', [id]);
    // Worker share is computed on the service price only; the warranty fee stays with the platform.
    expect(b[0]).toMatchObject({ amount: 64800, commission_amount: 11980 + 4900, worker_payout: 47920 });
    expect(b[0].warranty_until).toBeTruthy();

    // 10 days later: an ordinary dispute is out of time, a warranty claim is not.
    await query(`UPDATE bookings SET confirmed_at = now() - interval '10 days' WHERE id = $1`, [id]);
    const late = await api().post(`/api/bookings/${id}/dispute`).set(auth(c.token)).send({ reason: 'poor_quality', description: 'AC stopped cooling again' });
    expect(late.status).toBe(409);
    await api().post(`/api/bookings/${id}/dispute`).set(auth(c.token)).send({ reason: 'warranty_claim', description: 'AC stopped cooling again' }).expect(201);

    const d = await api().get('/api/admin/disputes').set(auth(ops)).expect(200);
    const dispute = d.body.disputes.find((x) => x.booking_id === id);
    const r = await api().post(`/api/admin/disputes/${dispute.id}/resolve`).set(auth(ops)).send({
      outcome: 'warranty_revisit', revisitTime: istSlot(3, 12), resolution: 'Free revisit by the same professional',
    }).expect(200);
    const revisitId = r.body.revisitBookingId;
    const { rows: rv } = await query('SELECT status, amount, worker_id, worker_payout FROM bookings WHERE id = $1', [revisitId]);
    expect(rv[0]).toEqual({ status: 'assigned', amount: 0, worker_id: w.workerId, worker_payout: 0 });

    // The revisit still needs GPS check-in and the customer's new code.
    await query(`UPDATE bookings SET scheduled_time = now() + interval '30 minutes' WHERE id = $1`, [revisitId]);
    await api().post(`/api/worker/jobs/${revisitId}/checkin`).set(auth(w.token)).send(AT_ADDRESS).expect(200);
    const v = await api().get(`/api/bookings/${revisitId}`).set(auth(c.token)).expect(200);
    await api().post(`/api/worker/jobs/${revisitId}/complete`).set(auth(w.token)).send({ otp: v.body.booking.completionOtp, ...AT_ADDRESS }).expect(200);
    await api().post(`/api/bookings/${revisitId}/confirm`).set(auth(c.token)).expect(200);
    await runJob('reconciliation');
    const { rows: rec } = await query('SELECT reconciliation_status FROM bookings WHERE id = $1', [revisitId]);
    expect(rec[0].reconciliation_status).toBe('clean');
  });

  it('a revisit cannot be inserted for a booking without active warranty (DB guard)', async () => {
    const c = await customer();
    const id = await paidBooking(c, { daysAhead: 4 });
    await expect(query(
      `INSERT INTO bookings (customer_id, service_id, address_id, address_enc, pincode, lat, lng, scheduled_time, amount,
                             warranty_parent_id, completion_otp_enc, status)
       SELECT customer_id, service_id, address_id, address_enc, pincode, lat, lng, scheduled_time, 0, id, completion_otp_enc, 'paid'
         FROM bookings WHERE id = $1`, [id])).rejects.toThrow(/active warranty/);
  });
});

describe('city managers (§4)', () => {
  it('see only their city and cannot hold money permissions', async () => {
    const other = await api().post('/api/admin/cities').set(auth(ops)).send({ name: 'Chennai' }).expect(201);
    const bad = await api().post('/api/admin/admins').set(auth(ops)).send({
      name: 'CM', email: 'cm-bad@example.com', temporaryPassword: 'An0ther!Strong#1', permissions: ['payouts.approve'], cityIds: [blrId],
    });
    expect(bad.status).toBe(400);
    const created = await api().post('/api/admin/admins').set(auth(ops)).send({
      name: 'Chennai Manager', email: 'cm@example.com', temporaryPassword: 'An0ther!Strong#1',
      permissions: ['bookings.manage', 'workers.kyc', 'reports.view'], cityIds: [other.body.city.id],
    }).expect(201);
    await api().post(`/api/admin/admins/${created.body.id}/approve-access`).set(auth(fin)).send({ approve: true }).expect(200);
    await query(`UPDATE admin_accounts SET password_hash = (SELECT password_hash FROM admin_accounts a JOIN users u ON u.id = a.user_id WHERE u.email = 'ops3@example.com') WHERE user_id = $1`, [created.body.id]);
    const cm = await adminLogin('cm@example.com');

    const c = await customer();
    const bengaluruBooking = await paidBooking(c, { daysAhead: 5 });
    const list = await api().get('/api/admin/bookings').set(auth(cm)).expect(200);
    expect(list.body.bookings.find((b) => b.id === bengaluruBooking)).toBeUndefined();
    await api().get(`/api/admin/bookings/${bengaluruBooking}`).set(auth(cm)).expect(404);
    const all = await api().get('/api/admin/bookings').set(auth(ops)).expect(200);
    expect(all.body.bookings.find((b) => b.id === bengaluruBooking)).toBeTruthy();
    const rep = await api().get('/api/admin/reports?from=2026-01-01&to=2030-01-01').set(auth(cm)).expect(200);
    expect(rep.body.byCity.map((x) => x.name)).toEqual(['Chennai']);
  });

  it('franchise settlement reports the operator share of commission', async () => {
    const rep = await api().get('/api/admin/reports?from=2026-01-01&to=2030-01-01').set(auth(ops)).expect(200);
    const blr = rep.body.byCity.find((x) => x.name === 'Bengaluru');
    expect(blr.commission).toBeGreaterThan(0);
    expect(blr.franchise_share).toBe(Math.floor(blr.commission * 0.3));
  });
});

describe('sponsored placements', () => {
  it('only https links; served, counted and redirected', async () => {
    const bad = await api().post('/api/admin/ads').set(auth(ops)).field('brand', 'X').field('title', 'Bad').field('linkUrl', 'http://x.example')
      .field('slot', 'home_banner').field('startsOn', '2020-01-01').field('endsOn', '2099-01-01');
    expect(bad.status).toBe(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const ok = await api().post('/api/admin/ads').set(auth(ops)).field('brand', 'CoolAir').field('title', 'AC filters 20% off')
      .field('linkUrl', 'https://coolair.example/offer').field('slot', 'home_banner').field('startsOn', '2020-01-01').field('endsOn', '2099-01-01')
      .attach('image', png, { filename: 'a.png', contentType: 'image/png' }).expect(201);
    const ads = await api().get('/api/ads?slot=home_banner&pincode=560001').expect(200);
    expect(ads.body.ads[0]).toMatchObject({ brand: 'CoolAir', imageUrl: `/api/ads/${ok.body.id}/image` });
    const click = await api().get(`/api/ads/${ok.body.id}/click`).expect(302);
    expect(click.headers.location).toBe('https://coolair.example/offer');
    const { rows } = await query('SELECT impressions, clicks FROM ad_placements WHERE id = $1', [ok.body.id]);
    expect(rows[0]).toEqual({ impressions: 1, clicks: 1 });
  });
});

describe('mobile clients and catalogue edits', () => {
  it('native apps get a rotating refresh token in the body; browsers never do', async () => {
    const phone = nextPhone();
    await api().post('/api/auth/otp/request').send({ phone, role: 'customer' }).expect(200);
    const code = sms.lastDevOtp.get(`+91${phone}`);
    const login = await api().post('/api/auth/otp/verify').set('X-Client', 'mobile')
      .send({ phone, role: 'customer', code, acceptPrivacyPolicy: true }).expect(200);
    expect(login.body.refreshToken).toBeTruthy();
    expect(login.headers['set-cookie']).toBeUndefined();
    const r1 = await api().post('/api/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    await api().post('/api/auth/refresh').set('X-Client', 'mobile').send({ refreshToken: login.body.refreshToken }).expect(401);
    // A web page can't ask for the token in the body.
    const web = await api().post('/api/auth/refresh').set('X-Client', 'mobile').set('Origin', 'http://localhost:5173')
      .send({ refreshToken: r1.body.refreshToken });
    expect(web.body.refreshToken).toBeUndefined();
  });

  it('editing one service field leaves the others unchanged', async () => {
    const { rows } = await query(`SELECT id, urgent_premium_bps, warranty_fee_paise FROM services WHERE name = 'AC service'`);
    await api().patch(`/api/admin/services/${rows[0].id}`).set(auth(ops)).send({ name: 'AC service (split)' }).expect(200);
    const { rows: after } = await query('SELECT name, urgent_premium_bps, warranty_fee_paise FROM services WHERE id = $1', [rows[0].id]);
    expect(after[0]).toEqual({ name: 'AC service (split)', urgent_premium_bps: rows[0].urgent_premium_bps, warranty_fee_paise: rows[0].warranty_fee_paise });
    await api().patch(`/api/admin/services/${rows[0].id}`).set(auth(ops)).send({ name: 'AC service' }).expect(200);
  });
});
