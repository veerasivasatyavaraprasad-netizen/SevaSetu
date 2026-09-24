// Payment gateway adapter (Section 8).
//
// razorpay: Razorpay Orders + Checkout for collection, signature and
//   webhook verification, refunds, and RazorpayX for fund-account
//   validation (penny drop) and weekly payouts. Funds settle to the
//   platform's account — never to the worker directly.
// mock: development/test only. Same interface and the same HMAC checkout
//   signature scheme, so the server-side verification path is identical.
//   validateConfig() refuses to start production with it.

import crypto from 'node:crypto';
import { config } from '../config.js';
import { hmacHex, randomToken, timingSafeEqualStr } from '../lib/crypto.js';

const RZP = 'https://api.razorpay.com/v1';

async function rzp(method, path, body, extraHeaders = {}) {
  const { razorpayKeyId, razorpayKeySecret } = config.payments;
  const auth = Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64');
  const res = await fetch(`${RZP}${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = json?.error?.description || `HTTP ${res.status}`;
    const err = new Error(`Razorpay ${method} ${path} failed: ${desc}`);
    err.gateway = json;
    throw err;
  }
  return json;
}

const razorpay = {
  name: 'razorpay',
  publicKey: () => config.payments.razorpayKeyId,

  async createOrder({ amount, receipt, notes }) {
    const order = await rzp('POST', '/orders', { amount, currency: 'INR', receipt, notes });
    return { orderId: order.id };
  },

  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    const expected = hmacHex(config.payments.razorpayKeySecret, `${orderId}|${paymentId}`);
    return timingSafeEqualStr(expected, signature);
  },

  // Never trust the client's word that it paid: fetch from the gateway,
  // and capture if the account isn't on auto-capture.
  async fetchAndCapture(paymentId, expectedAmount) {
    let p = await rzp('GET', `/payments/${encodeURIComponent(paymentId)}`);
    if (p.status === 'authorized') {
      p = await rzp('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, {
        amount: expectedAmount, currency: 'INR',
      });
    }
    return { status: p.status, amount: p.amount, orderId: p.order_id, currency: p.currency };
  },

  verifyWebhook(rawBody, signature) {
    if (!signature) return false;
    const expected = hmacHex(config.payments.razorpayWebhookSecret, rawBody);
    return timingSafeEqualStr(expected, signature);
  },

  async refund(paymentId, amount, idempotencyKey) {
    const r = await rzp('POST', `/payments/${encodeURIComponent(paymentId)}/refund`,
      { amount, speed: 'normal', receipt: idempotencyKey.slice(0, 40) });
    return { refundId: r.id, status: r.status };
  },

  // Section 8: verify payout account via penny drop before any money is sent.
  async registerAndVerifyPayoutAccount({ workerId, name, method, bankAccount, vpa }) {
    const contact = await rzp('POST', '/contacts', { name, type: 'vendor', reference_id: workerId });
    const fundBody = method === 'vpa'
      ? { contact_id: contact.id, account_type: 'vpa', vpa: { address: vpa } }
      : {
        contact_id: contact.id,
        account_type: 'bank_account',
        bank_account: { name, ifsc: bankAccount.ifsc, account_number: bankAccount.accountNumber },
      };
    const fa = await rzp('POST', '/fund_accounts', fundBody);
    let v = await rzp('POST', '/fund_accounts/validations', {
      account_number: config.payments.razorpayXAccountNumber,
      fund_account: { id: fa.id },
      amount: 100,
      currency: 'INR',
      notes: { worker_id: workerId },
    });
    for (let i = 0; i < 10 && v.status === 'created'; i += 1) {
      await new Promise((r) => { setTimeout(r, 2000); });
      v = await rzp('GET', `/fund_accounts/validations/${v.id}`);
    }
    const active = v.status === 'completed' && v.results?.account_status === 'active';
    return {
      verified: active,
      pending: v.status === 'created',
      fundAccountId: fa.id,
      nameAtBank: v.results?.registered_name || null,
    };
  },

  async createPayout({ fundAccountId, amount, referenceId, idempotencyKey, mode }) {
    const p = await rzp('POST', '/payouts', {
      account_number: config.payments.razorpayXAccountNumber,
      fund_account_id: fundAccountId,
      amount,
      currency: 'INR',
      mode,
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: referenceId.slice(0, 40),
      narration: 'Weekly earnings',
    }, { 'X-Payout-Idempotency': idempotencyKey });
    return { payoutId: p.id, status: p.status, utr: p.utr || null };
  },
};

// ---------------------------------------------------------------------
const MOCK_SECRET = 'mock-gateway-secret';
const mockPayments = new Map();
const mockOrders = new Map();

const mock = {
  name: 'mock',
  publicKey: () => 'mock_key',

  async createOrder({ amount }) {
    const orderId = `order_mock_${randomToken(9)}`;
    mockOrders.set(orderId, { amount });
    return { orderId };
  },

  // Simulates what Razorpay Checkout returns to the browser on success.
  simulateCheckout(orderId) {
    const order = mockOrders.get(orderId);
    if (!order) return null;
    const paymentId = `pay_mock_${randomToken(9)}`;
    mockPayments.set(paymentId, { orderId, amount: order.amount, status: 'captured' });
    return { paymentId, signature: hmacHex(MOCK_SECRET, `${orderId}|${paymentId}`) };
  },

  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    return timingSafeEqualStr(hmacHex(MOCK_SECRET, `${orderId}|${paymentId}`), signature);
  },

  async fetchAndCapture(paymentId) {
    const p = mockPayments.get(paymentId);
    if (!p) throw new Error('mock payment not found');
    return { status: p.status, amount: p.amount, orderId: p.orderId, currency: 'INR' };
  },

  verifyWebhook(rawBody, signature) {
    return !!signature && timingSafeEqualStr(hmacHex(MOCK_SECRET, rawBody), signature);
  },
  signWebhook(rawBody) {
    return hmacHex(MOCK_SECRET, rawBody);
  },

  async refund() {
    return { refundId: `rfnd_mock_${randomToken(9)}`, status: 'processed' };
  },

  async registerAndVerifyPayoutAccount({ method, bankAccount }) {
    // Deterministic failure hook for tests: account numbers ending 0000 fail.
    const failed = method === 'bank_account' && bankAccount.accountNumber.endsWith('0000');
    return {
      verified: !failed, pending: false, fundAccountId: `fa_mock_${randomToken(9)}`, nameAtBank: null,
    };
  },

  async createPayout() {
    return { payoutId: `pout_mock_${randomToken(9)}`, status: 'processed', utr: `MOCKUTR${crypto.randomInt(1e9, 1e10)}` };
  },
};

export const payments = config.payments.provider === 'razorpay' ? razorpay : mock;
