// SMS (MSG91), masked calling (Exotel) and push (FCM HTTP v1) adapters.
// Console providers exist for local development only; validateConfig()
// blocks them in production.

import crypto from 'node:crypto';
import { config } from '../config.js';

// ---------------------------------------------------------------- SMS
async function msg91Flow(templateId, phoneE164, vars) {
  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: config.sms.msg91AuthKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      template_id: templateId,
      short_url: '0',
      recipients: [{ mobiles: phoneE164.replace(/^\+/, ''), ...vars }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`MSG91 send failed: HTTP ${res.status}`);
}

export const sms = {
  async sendOtp(phoneE164, code) {
    if (config.sms.provider === 'msg91') {
      return msg91Flow(config.sms.msg91OtpTemplateId, phoneE164, { otp: code });
    }
    if (!config.isTest) console.log(`[dev-sms] OTP for ${phoneE164}: ${code}`);
    sms.lastDevOtp.set(phoneE164, code);
    return undefined;
  },
  async sendNotice(phoneE164, text) {
    if (config.sms.provider === 'msg91' && config.sms.msg91NoticeTemplateId) {
      return msg91Flow(config.sms.msg91NoticeTemplateId, phoneE164, { message: text.slice(0, 120) });
    }
    if (!config.isTest) console.log(`[dev-sms] to ${phoneE164}: ${text}`);
    return undefined;
  },
  // Development/test visibility only.
  lastDevOtp: new Map(),
};

// ------------------------------------------------------- masked calls
// Section 9.1: both legs are bridged through a virtual number; neither
// party ever sees the other's real phone number.
export const calls = {
  async bridge({ fromE164, toE164 }) {
    if (config.calls.provider === 'exotel') {
      const c = config.calls;
      const auth = Buffer.from(`${c.exotelApiKey}:${c.exotelApiToken}`).toString('base64');
      const body = new URLSearchParams({ From: fromE164, To: toE164, CallerId: c.exotelCallerId, CallType: 'trans' });
      const res = await fetch(`https://${c.exotelSubdomain}/v1/Accounts/${c.exotelSid}/Calls/connect.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Exotel call failed: HTTP ${res.status}`);
      return { callId: json?.Call?.Sid || null };
    }
    if (!config.isTest) console.log('[dev-call] bridging masked call (numbers withheld)');
    return { callId: `devcall_${crypto.randomUUID()}` };
  },
};

// --------------------------------------------------------------- push
let fcmToken = null;

async function fcmAccessToken(sa) {
  if (fcmToken && fcmToken.expiresAt > Date.now() + 60_000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('FCM auth failed');
  fcmToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return fcmToken.value;
}

export const push = {
  async send(tokens, { title, body, data = {} }) {
    if (config.push.provider !== 'fcm' || tokens.length === 0) return;
    const sa = JSON.parse(config.push.fcmServiceAccountJson);
    const access = await fcmAccessToken(sa);
    await Promise.allSettled(tokens.map((token) => fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token, notification: { title, body }, data } }),
        signal: AbortSignal.timeout(10_000),
      },
    )));
  },
};
