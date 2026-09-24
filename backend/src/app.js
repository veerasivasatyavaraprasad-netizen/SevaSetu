import cookieParser from 'cookie-parser';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './lib/errors.js';
import { adminRouter } from './routes/admin.js';
import { adminAuthRouter } from './routes/adminAuth.js';
import { authRouter } from './routes/auth.js';
import { commsRouter } from './routes/comms.js';
import { customerRouter } from './routes/customer.js';
import { webhookRouter } from './routes/webhooks.js';
import { workerRouter } from './routes/worker.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));
  app.use(cors({
    origin(origin, cb) {
      // Non-browser clients (mobile apps, gateway webhooks) send no Origin.
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    maxAge: 600,
  }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Raw body for webhook signature verification: mount before json().
  app.use('/api/webhooks', webhookRouter);

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // CSRF defence for cookie-authenticated endpoints (refresh/logout): a
  // browser request must come from an allowed origin.
  app.use((req, _res, next) => {
    const origin = req.get('origin');
    if (req.method !== 'GET' && origin && !config.corsOrigins.includes(origin)) {
      throw new HttpError(403, 'forbidden', 'Origin not allowed');
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/admin-auth', adminAuthRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/worker', workerRouter);
  app.use('/api', commsRouter);
  app.use('/api', customerRouter);

  if (config.serveFrontend) mountFrontend(app, config.serveFrontend);

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'Not found')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
      return;
    }
    if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'too_large', message: 'Request too large' });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'bad_request', message: 'Malformed JSON' });
      return;
    }
    // Database trigger rejections are integrity violations, not server bugs.
    if (err?.code === 'P0001') {
      res.status(409).json({ error: 'integrity_violation', message: err.message });
      return;
    }
    if (err?.code === '23505') {
      res.status(409).json({ error: 'conflict', message: 'Duplicate request' });
      return;
    }
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).json({ error: 'internal', message: 'Something went wrong' });
  });

  return app;
}

// Content-Security-Policy per frontend (the API's own CSP is 'none').
const FRONTEND_CSP = {
  web: "default-src 'self'; script-src 'self' https://checkout.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; connect-src 'self' https://lumberjack.razorpay.com; img-src 'self' data: https://*.razorpay.com; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  admin: "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; frame-src blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
};

// Serves a built frontend (web/dist or admin/dist) with SPA fallback, so
// the app and its API share one origin.
function mountFrontend(app, name) {
  if (!FRONTEND_CSP[name]) throw new Error(`SERVE_FRONTEND must be "web" or "admin"`);
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', name, 'dist');
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`SERVE_FRONTEND=${name} but ${index} is missing; build it first`);
  const headers = (res) => {
    res.set('Content-Security-Policy', FRONTEND_CSP[name]);
    res.set('Permissions-Policy', name === 'web' ? 'geolocation=(self), camera=(self), microphone=()' : 'geolocation=(), camera=(), microphone=()');
    if (name === 'admin') res.set('X-Robots-Tag', 'noindex, nofollow');
  };
  app.use('/assets', express.static(path.join(dir, 'assets'), {
    immutable: true, maxAge: '1y', index: false,
    setHeaders: (res) => { headers(res); res.set('Cache-Control', 'public, max-age=31536000, immutable'); },
  }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    headers(res);
    res.set('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
}
