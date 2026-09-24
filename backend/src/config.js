// Central, validated configuration. The process refuses to start in
// production with insecure or development-only settings.

const env = process.env;

function int(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function list(name, fallback = []) {
  const raw = env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const nodeEnv = env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

// Development-only fallbacks. Never used in production (checked below).
const DEV_KEY = 'dev-only-insecure-key-change-me-0000000000000000';

export const config = {
  nodeEnv,
  isProduction,
  isTest,
  port: int('PORT', 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://sevasetu:sevasetu@localhost:5432/sevasetu',
  // Comma-separated exact origins allowed to call the API with credentials.
  // Exact origins allowed to call the API. On Render, the service's own
  // public URL (RENDER_EXTERNAL_URL) is added automatically.
  corsOrigins: [
    ...list('CORS_ORIGINS', env.RENDER_EXTERNAL_URL ? [] : ['http://localhost:5173', 'http://localhost:5174']),
    ...(env.RENDER_EXTERNAL_URL ? [env.RENDER_EXTERNAL_URL.replace(/\/$/, '')] : []),
  ],
  // Serve a built frontend ('web' or 'admin') from this process, so the
  // app and API share one origin (used by the Render blueprint).
  serveFrontend: env.SERVE_FRONTEND || '',
  pgSsl: env.PGSSL === 'true' || /sslmode=require/.test(env.DATABASE_URL || ''),
  bootstrap: {
    opsEmail: env.BOOTSTRAP_OPS_EMAIL || '',
    opsPassword: env.BOOTSTRAP_OPS_PASSWORD || '',
    financeEmail: env.BOOTSTRAP_FINANCE_EMAIL || '',
    financePassword: env.BOOTSTRAP_FINANCE_PASSWORD || '',
  },
  // Reverse proxies in front of the API, for correct client IPs. "all"
  // trusts the whole X-Forwarded-For chain (for hosts with an unknown
  // number of proxy hops); per-phone and per-account limits still apply.
  trustProxy: env.TRUST_PROXY_HOPS === 'all' ? true : int('TRUST_PROXY_HOPS', 0),

  jwtSecret: env.JWT_SECRET || DEV_KEY,
  // 32-byte keys, base64 encoded. Separate keys for encryption and for
  // the lookup HMAC so leaking one doesn't compromise the other.
  piiEncryptionKey: env.PII_ENCRYPTION_KEY || '',
  lookupHmacKey: env.LOOKUP_HMAC_KEY || '',

  accessTokenTtlSec: 15 * 60,
  customerSessionDays: 30, // Section 5.5
  adminSessionHours: 2, // absolute cap for admin (Section 5.5)
  adminIdleMinutes: 120, // auto-expire after 2h inactivity (Section 5.3)

  otp: {
    ttlSec: 300,
    maxPerWindow: 3, // Section 10: max 3 per 10 minutes per number
    windowSec: 600,
    maxAttempts: 5,
  },
  admin: {
    maxFailedLogins: 5,
    lockoutMinutes: 30,
    totpIssuer: env.TOTP_ISSUER || 'SevaSetu Admin',
  },

  booking: {
    checkinRadiusM: int('CHECKIN_RADIUS_M', 200),
    gpsFlagDistanceM: int('GPS_FLAG_DISTANCE_M', 1000),
    maxGpsAccuracyM: int('MAX_GPS_ACCURACY_M', 100),
    autoConfirmHours: 24, // Section 7.1 step 5
    completionOtpMaxAttempts: 5,
    minLeadMinutes: int('BOOKING_MIN_LEAD_MINUTES', 60),
    urgentWithinHours: 6,
    freeCancelHoursBefore: 2,
    lateCancelFeeBps: int('LATE_CANCEL_FEE_BPS', 1000),
    warrantyDays: 30, // plan §2: 30-day service guarantee
    featuredPriorityMinutes: int('FEATURED_PRIORITY_MINUTES', 10),
    featuredPriorityUrgentMinutes: int('FEATURED_PRIORITY_URGENT_MINUTES', 2),
  },

  defaultCommissionBps: int('DEFAULT_COMMISSION_BPS', 2000), // 20%, within 15–25%
  payoutTwoPersonThresholdPaise: int('PAYOUT_TWO_PERSON_THRESHOLD_PAISE', 50_000_00), // ₹50,000
  refundTwoPersonThresholdPaise: int('REFUND_SECOND_APPROVER_THRESHOLD_PAISE', 0),

  policyVersion: env.WORKER_POLICY_VERSION || '2026-01',
  privacyPolicyVersion: env.PRIVACY_POLICY_VERSION || '2026-01',

  payments: {
    provider: env.PAYMENT_PROVIDER || 'mock', // 'razorpay' | 'mock'
    razorpayKeyId: env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: env.RAZORPAY_KEY_SECRET || '',
    razorpayWebhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
    razorpayXAccountNumber: env.RAZORPAYX_ACCOUNT_NUMBER || '',
  },
  sms: {
    provider: env.SMS_PROVIDER || 'console', // 'msg91' | 'console'
    msg91AuthKey: env.MSG91_AUTH_KEY || '',
    msg91OtpTemplateId: env.MSG91_OTP_TEMPLATE_ID || '',
    msg91NoticeTemplateId: env.MSG91_NOTICE_TEMPLATE_ID || '',
  },
  calls: {
    provider: env.CALL_PROVIDER || 'console', // 'exotel' | 'console'
    exotelSid: env.EXOTEL_SID || '',
    exotelApiKey: env.EXOTEL_API_KEY || '',
    exotelApiToken: env.EXOTEL_API_TOKEN || '',
    exotelCallerId: env.EXOTEL_CALLER_ID || '',
    exotelSubdomain: env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
  },
  push: {
    provider: env.PUSH_PROVIDER || 'none', // 'fcm' | 'none'
    fcmServiceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON || '',
  },
  jobs: {
    enabled: env.RUN_SCHEDULER !== 'false' && !isTest,
    reconciliationHourIst: int('RECONCILIATION_HOUR_IST', 2),
  },
};

export function validateConfig() {
  const problems = [];
  if (isProduction) {
    if (config.jwtSecret === DEV_KEY || config.jwtSecret.length < 32) {
      problems.push('JWT_SECRET must be set to a random value of at least 32 characters');
    }
    if (!config.piiEncryptionKey) problems.push('PII_ENCRYPTION_KEY is required');
    if (!config.lookupHmacKey) problems.push('LOOKUP_HMAC_KEY is required');
    if (config.piiEncryptionKey && config.piiEncryptionKey === config.lookupHmacKey) {
      problems.push('PII_ENCRYPTION_KEY and LOOKUP_HMAC_KEY must differ');
    }
    if (config.payments.provider !== 'razorpay') {
      problems.push('PAYMENT_PROVIDER must be razorpay in production (mock is dev-only)');
    }
    if (config.sms.provider !== 'msg91') {
      problems.push('SMS_PROVIDER must be msg91 in production (console prints OTPs to logs)');
    }
    if (config.calls.provider !== 'exotel') {
      problems.push('CALL_PROVIDER must be exotel in production');
    }
    if (config.sms.provider === 'msg91' && (!config.sms.msg91AuthKey || !config.sms.msg91OtpTemplateId)) {
      problems.push('MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required');
    }
    const c = config.calls;
    if (c.provider === 'exotel' && (!c.exotelSid || !c.exotelApiKey || !c.exotelApiToken || !c.exotelCallerId)) {
      problems.push('EXOTEL_SID, EXOTEL_API_KEY, EXOTEL_API_TOKEN and EXOTEL_CALLER_ID are required');
    }
    if (config.corsOrigins.some((o) => o.startsWith('http://'))) {
      problems.push('CORS_ORIGINS must be https:// origins in production');
    }
    const p = config.payments;
    if (p.provider === 'razorpay' && (!p.razorpayKeyId || !p.razorpayKeySecret || !p.razorpayWebhookSecret)) {
      problems.push('RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required');
    }
    if (p.provider === 'razorpay' && !p.razorpayXAccountNumber) {
      problems.push('RAZORPAYX_ACCOUNT_NUMBER is required for worker payouts');
    }
  }
  if (problems.length) {
    throw new Error(`Refusing to start with insecure configuration:\n - ${problems.join('\n - ')}`);
  }
}
