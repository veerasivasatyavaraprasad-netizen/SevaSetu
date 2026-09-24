# SevaSetu — hyperlocal home-services marketplace

SevaSetu (*seva*, service + *setu*, bridge) is a working build of the *Hyperlocal Services Marketplace — Complete Project Plan (v1.0)*. It connects customers who need home services with vetted local workers. The platform controls the whole booking and payment flow, and cash leakage is treated as a design problem, not a policy.

> **Core principle (plan §1):** no job is valid, no worker is paid, and no rating is recorded unless it happened inside the app's tracked flow: booking → in-app payment → verified completion → payout.

| Part | Path | Stack |
|---|---|---|
| API | `backend/` | Node.js 22 + Express 5, PostgreSQL 16 |
| Customer & worker app | `web/` | React 19 + Vite (mobile-first PWA-style web app) |
| Admin panel | `admin/` | React 19 + Vite, meant for a **separate subdomain** (§10) |
| Mobile app (Android & iOS) | `mobile/` | Expo SDK 57 + React Native, for customers and workers ([mobile/README.md](mobile/README.md)) |

The stack follows plan §11. Payments use Razorpay (Checkout, Refunds) and RazorpayX (penny-drop fund-account validation and payouts). SMS OTP uses MSG91. Masked calling uses Exotel. Push notifications use Firebase Cloud Messaging.

---

## What's implemented, mapped to the plan

### §3 Screens
- **Customer:** OTP login; home with service search and categories; service detail with reviews; booking (address with GPS pin, date and slot, fixed-price quote, urgent premium, cancellation-policy consent, pay); My Bookings; booking detail (live status timeline, completion code, in-app chat and masked call, "Worker asked for cash", confirm and rate, raise a dispute, cancel); subscription plans; profile with addresses, notifications, data export and account deletion.
- **Worker:** onboarding and KYC wizard (profile and ID, document upload, penny-drop-verified bank/UPI, anti-cash policy sign-off, submit), then an "Under review" gate; dashboard (today's jobs, earnings, open requests with accept or skip); job detail (address only after acceptance, navigation, GPS check-in, completion-OTP entry, chat and masked call, withdraw); earnings and weekly payouts; ratings; policy.
- **Admin:** dashboard; bookings (filter, detail with GPS, payment and chat evidence, manual reassign, cancel and refund); workers (KYC review with audited document viewing, suspend, payout hold, strikes, commission and reactivation requests); customers (search by exact phone); payouts (weekly batch, approvals, release, CSV export); disputes; refund approvals; fraud and anomaly queue; change approvals; services and pricing; reports (revenue, commission, cash-complaint rate, top and bottom workers); audit log with chain verification and admin sign-in log; admin accounts and quarterly access review; background jobs.

### §4 Roles & permissions
The customer, worker and admin roles are enforced server-side. Each admin gets an explicit permission set from 15 permissions (`backend/src/lib/permissions.js`) instead of a single all-powerful role. Conflicting duties can't be held together; for example, `payouts.approve` excludes `commission.request` and `payouts.prepare`. No admin can edit worker bank details at all: only the worker can, through penny-drop re-verification.

**City managers (§4, Phase 3)** are admins limited to one or more cities. They see only their cities' bookings, workers, disputes, fraud flags, customers, dashboard and reports; anything else returns "not found". They can only hold local-operations permissions (reports, KYC approval, bookings, fraud review, enforcement, disputes), never commission, payouts, refunds, pricing, admin access or gateway settings.

### §2 / §12 Phase 3 revenue features
- **Cities and franchises:** each city has serviceable PIN codes (bookings and worker areas elsewhere are refused), an optional franchise operator, and their share of commission. Reports include a per-city **franchise settlement**.
- **Featured listings:** workers buy a plan in-app (Razorpay). Featured professionals get the first notification and a priority window (10 minutes, 2 for urgent jobs) during which only they can see and accept new jobs. This is enforced on both the job list and acceptance.
- **30-day warranty add-on:** a per-service fee. The fee is platform revenue, so the worker's share is computed on the service price. Warranty claims are accepted after the normal 7-day dispute window. An admin can resolve a claim with a **free revisit** by the original worker, which still needs a GPS check-in and a new customer code, and whose zero price is covered by the original payment (database-guarded).
- **Surge pricing:** same-day urgent premium.
- **Advertising:** sponsored placements (home banner, after payment) that can target a category or city, with https-only admin-entered links and impression and click counting. They're always labelled "Sponsored".

### §5 Authentication
- Customers and workers log in with phone + OTP: a 6-digit code with a 5-minute TTL, at most 3 requests per number per 10 minutes, and 5 wrong attempts before it locks. Explicit privacy consent is recorded on signup.
- New workers are routed to onboarding. Workers reach the dashboard only when `kyc_status = approved`.
- Admins log in with email + argon2id password, then **mandatory TOTP 2FA**. Enrolment happens at first login, and code replay is blocked. The account locks after 5 failures. Every attempt is logged with IP and user agent. Sessions expire after 2 hours of inactivity. There is no public signup: the first admins are created by CLI.
- Access JWTs (HS256, algorithm pinned) last 15 minutes. The role is never trusted from the token alone: every request re-loads the session, user status, role and permissions from the database. Refresh tokens are httpOnly SameSite=Strict cookies, stored hashed, rotated on every use and revoked on logout. **Reusing a rotated token revokes the whole session family.** Admin sessions last 2 hours; customer and worker sessions last 30 days.

### §6 Database
PostgreSQL. `backend/src/migrations/001_init.sql` contains every table in the plan plus the ones the controls need: sessions, OTPs, consents, KYC documents, GPS pings, payout items and batches, refund requests, change requests, cash reports, messages, masked calls, strikes and job runs. Money is integer paise and rates are basis points, so no floating point ever touches money.

Several rules are enforced **by database triggers**, so an app bug or a compromised admin session can't bypass them:
- A booking can't reach `paid`, `in_progress`, `completed` or `confirmed` without a captured in-app payment (§9.1).
- It can't start without a GPS check-in, or complete without the customer's OTP (§9.2, §9.3).
- The price can't change after the booking is created, and status changes follow a fixed state machine.
- The preparer of a payout batch can never approve it, and a paid payout line is final.
- `audit_logs` is append-only (UPDATE, DELETE and TRUNCATE are rejected) and **hash-chained**: tampering, even by a superuser who disables the trigger, is detected by `GET /api/admin/audit-logs/verify`.

### §7 Flows
- **Booking:** the customer pays upfront into the platform. The job is broadcast to approved workers with the matching skill and PIN code (admins can also assign manually). Then: GPS check-in → customer OTP → completion → customer confirmation (or auto-confirm after 24 h) → payout queue.
- **Commission:** `worker_payout = amount − round(amount × rate)`, using the worker's own rate, snapshotted when the job is accepted. Commission + payout always equals the amount exactly.
- **Subscriptions:** charged upfront; visits are generated automatically as prepaid bookings that follow the same OTP, GPS and payout rules.

### §8 Payments & escrow
Razorpay Orders and Checkout. The server verifies the checkout signature **and** fetches the payment from the gateway, checking status, amount and order before marking anything paid. A signed, idempotent webhook (`/api/webhooks/razorpay`) is the backstop if the browser closes early. Workers' payout accounts are verified by penny drop, and only the provider's fund-account token is stored, never the account number (§10). Payouts are weekly batches sent through RazorpayX, with an idempotency key per payout so a retry can never double-pay.

### §9 Security & anti-fraud (cash-leakage prevention)
| Plan | Implementation |
|---|---|
| 9.1 In-app payment unavoidable | No "mark as paid (cash)" anywhere. Fixed server-side prices. Address and job details are released only after payment and acceptance. Chat and masked calls only (customer phone never shown). Chat redacts phone numbers, emails, UPI IDs and WhatsApp/Telegram links, and flags workers who mention cash or UPI. |
| 9.2 GPS verification | Check-in must be within `CHECKIN_RADIUS_M` (default 200 m) with acceptable accuracy, inside a time window. Check-out GPS is logged. Far check-ins or check-outs are flagged. A mock-location report means **immediate suspension** (§9.6). |
| 9.3 Customer OTP | A 4-digit code, stored encrypted and shown only to the customer (not even to admins). 5 attempts, then the job is locked and flagged. |
| 9.4 Reconciliation engine | Runs nightly (02:00 IST by default). A booking is `clean` only if the gateway payment, the GPS check-in and the customer OTP all agree. Anything else is held from payout and flagged for review. |
| 9.5 Anomaly rules | High customer-cancellation rate (review plus temporary payout hold); heavy masked calls with no new in-app bookings (reminder sent to the customer); rising job count with falling average value; repeated cash reports; one address booking many workers with very short jobs; cancel-then-never-rebook; any mismatch during a 30-day monitoring period; self-booking. All of these land in a severity-ranked human review queue. |
| 9.6 Strikes | Confirming a flag applies the plan's table exactly. Cash demand: warning plus forced policy re-acceptance, then a 7-day suspension, then deactivation. Off-app diversion: payout hold plus deactivation. Minor mismatch: reminder plus 30-day monitoring. GPS tampering: immediate suspension. Workers sign a versioned policy (hash recorded with IP and time). |
| 9.7 Customer safeguards | A one-tap "Worker asked for cash" button on active bookings, an "asked for cash" option in reviews and disputes, and in-app education that cash has no protection. |
| 9.8 Internal controls | Maker-checker on commission changes, worker reactivations, payout-hold releases, admin-initiated refunds and **new admin access grants**. Payout batches above ₹50,000 need two distinct approvers. Individual admin accounts. Every admin action is written to the hash-chained audit log, including each KYC document view. Quarterly access review with overdue highlighting. |

### §10 Data security & compliance
- PII (phone numbers, ID numbers, street addresses, KYC files) is encrypted with **AES-256-GCM**. Phone lookup uses a separate keyed HMAC.
- Admin passwords are hashed with argon2id.
- OTP rate limits per number (database-backed, so they hold across instances) plus per-IP limits.
- Strict CORS allow-list, an Origin check on state-changing requests, Helmet headers, and CSP/HSTS through the nginx configs.
- KYC uploads are type-checked by magic bytes, not by the file name or claimed MIME type.
- DPDP: consent is recorded; users can export their data and delete their account (identity erased, financial records kept for tax law).
- The API **refuses to start in production** with insecure settings: default secrets, mock payment/SMS/call providers, or non-HTTPS origins.

---

## Running locally

Requirements: Node 22+ and PostgreSQL 16 (or Docker).

```bash
# 1. Database
createuser -P sevasetu      # password: sevasetu (local only)
createdb -O sevasetu sevasetu
createdb -O sevasetu sevasetu_test

# 2. API (development providers: mock gateway, OTPs printed to the console)
cd backend
npm install
npm run seed -- --city Bengaluru --pincodes 560001,560002   # services + a first serviceable city
ADMIN_PASSWORD='Choose-A-Str0ng!Pass' npm run create-admin -- \
  --email ops@example.com --name "Ops" \
  --permissions reports.view,bookings.manage,workers.kyc,workers.enforce,commission.request,customers.view,disputes.manage,fraud.review,catalog.manage,audit.view,payouts.prepare,admins.manage,cities.manage,ads.manage
ADMIN_PASSWORD='An0ther-Str0ng!Pass' npm run create-admin -- \
  --email finance@example.com --name "Finance" \
  --permissions payouts.approve,refunds.approve,changes.approve,reports.view
npm run dev                                     # http://localhost:4000

# 3. Apps
cd ../web   && npm install && npm run dev       # http://localhost:5173
cd ../admin && npm install && npm run dev       # http://localhost:5174
```

The two admins exist because the maker-checker controls need two different people. In development, OTPs appear in the API log (`[dev-sms] OTP for +91…`). The payment button opens a development gateway that uses the same signature scheme as Razorpay.

With Docker: `docker compose up --build` gives you the web app on :8080 and admin on :8081. Then run `docker compose exec api npm run seed` and the `create-admin` commands above with `docker compose exec`.

### Tests
```bash
cd backend && npm test
```
56 integration tests run against a real PostgreSQL database (`TEST_DATABASE_URL`, default `sevasetu_test`, **which is wiped**). They cover:
- the full booking → payment → GPS → OTP → reconciliation → payout path;
- forged payment signatures and the database-level payment, price and state guards;
- OTP limits, refresh-token reuse, admin 2FA, lockout and idle expiry;
- maker-checker on commission, refunds, payouts and admin access;
- the strike ladder, anomaly rules, audit-chain tamper detection, subscriptions, webhooks, and DPDP export and deletion.

CI (`.github/workflows/ci.yml`) runs these tests plus both frontend builds and `npm audit`.

### Background jobs
The API runs them in-process, with a Postgres advisory lock so multiple instances never run the same job at once:
- every 10 minutes: `expire_payments`, `auto_confirm`, `subscriptions`;
- nightly: `reconciliation`, `anomalies`.

To use an external scheduler instead, set `RUN_SCHEDULER=false` and run `npm run run-job -- <name>` from cron. Admins can also trigger jobs from the panel.

---

## Deploying for free with no card: Koyeb + Neon

One free Koyeb server runs the app at `/` and the admin panel at `/ops/`, with a free Neon PostgreSQL database. Step-by-step guide: **[deploy/koyeb/README.md](deploy/koyeb/README.md)**.

## Deploying for free on Oracle Cloud (India)

One server in Mumbai or Hyderabad on Oracle's Always Free tier runs everything:
- the app, and the admin panel on its own address;
- PostgreSQL;
- automatic HTTPS;
- daily backups.

It's installed with one command (`deploy/oracle/setup.sh`). Step-by-step guide: **[deploy/oracle/README.md](deploy/oracle/README.md)**.

## Deploying live for free (Render + Neon, Singapore)

Hosting and database cost nothing. Pay-as-you-go costs remain for real usage:
- MSG91 charges per SMS (the login codes);
- Exotel charges per call minute;
- Razorpay takes about 2% of each payment and has no monthly fee.

`render.yaml` creates **sevasetu-app** (the customer and worker app plus API) and **sevasetu-admin** (the admin panel plus API, on its own subdomain) on Render's free plan in Singapore. Each service serves its frontend and the API from one origin, so there is no CORS or cookie setup.

1. **Database (Neon, free):**
   - Sign up at neon.tech and create a project in **AWS Asia Pacific (Singapore)**.
   - In *Connection details*, turn **off** "Connection pooling" and copy the connection string. It starts with `postgresql://` and ends with `sslmode=require`.
   - Use the direct connection, not the `-pooler` one: the app uses database locks that a pooler breaks.
2. **Render:** in the dashboard, **New + → Blueprint**, connect this GitHub repository, branch `main`, and keep the default Blueprint Path.
3. **Fill in the prompted values:**
   - `DATABASE_URL` (the Neon string);
   - the Razorpay, MSG91 and Exotel credentials;
   - two first-run admin emails and passwords (ops and finance, each 12+ characters with mixed character types).

   `JWT_SECRET`, `PII_ENCRYPTION_KEY` and `LOOKUP_HMAC_KEY` are generated for you. Copy `PII_ENCRYPTION_KEY` somewhere safe: losing it makes stored customer data unreadable.
4. Click **Apply**. The app will be at `https://sevasetu-app.onrender.com` and the admin panel at `https://sevasetu-admin.onrender.com`; the dashboard shows the exact URLs.
5. **Keep the app awake (free):**
   - At uptimerobot.com, add an HTTP(s) monitor for `https://<app URL>/api/health` every 5 minutes.
   - Free Render services sleep after 15 idle minutes; this keeps the customer app responsive and lets background jobs run.
   - Don't add the admin service. Render's free plan allows about 750 running hours a month across services, which covers one always-on service. The admin panel can sleep and takes about 50 seconds to open after a quiet period.
   - If the app does sleep through 02:00 IST, the nightly reconciliation runs as soon as it wakes. The day is not skipped.
6. **Razorpay:** in Dashboard → Webhooks, add `https://<app URL>/api/webhooks/razorpay` for `payment.captured`, `order.paid` and `payout.*` events, with the same webhook secret you entered in Render.
7. **Admin setup:**
   - Both admins sign in and enrol 2FA.
   - Ops launches the first city and its PIN codes under **Cities & franchises**, and adds services and prices under **Services & pricing**.

The API refuses to start if a production credential is missing or still set to a development provider. A half-configured deploy fails loudly instead of running insecurely.

**When you outgrow the free tier:**
- Change `plan: free` to `plan: starter` for both services in `render.yaml`, so they no longer sleep.
- Move Neon to a paid plan for more storage and backups.
- For Indian data residency, DigitalOcean App Platform (Bangalore) or AWS or Google Cloud (Mumbai) are the next steps.

## Going live

1. **Secrets:** generate `JWT_SECRET`, `PII_ENCRYPTION_KEY` and `LOOKUP_HMAC_KEY` with `openssl rand -base64 32`, and keep them in your host's secret manager. Losing `PII_ENCRYPTION_KEY` makes encrypted PII unreadable, so back it up separately from the database.
2. **Razorpay:** set `PAYMENT_PROVIDER=razorpay` plus the key ID and secret. Point a webhook at `https://api.<domain>/api/webhooks/razorpay` for `payment.captured`, `order.paid` and `payout.*` events, and set its secret. Enable RazorpayX and set `RAZORPAYX_ACCOUNT_NUMBER`.
3. **MSG91:** a DLT-registered OTP template with an `otp` variable (`SMS_PROVIDER=msg91`).
4. **Exotel:** an ExoPhone as `EXOTEL_CALLER_ID` (`CALL_PROVIDER=exotel`).
5. **Hosting:** serve `web/` on `app.<domain>` and `admin/` on a separate, unlinked subdomain (§10). Ideally put the admin panel behind an IP allow-list or VPN. Set `CORS_ORIGINS` to both HTTPS origins and `TRUST_PROXY_HOPS` to the number of proxies in front of the API.
6. **Backups:** automated Postgres backups **with a tested restore** (§10).
7. **Before launch:** a penetration test (§10), and legal review of the worker agreement text (`backend/src/lib/policy.js`), the refund policy and the privacy policy (§13).

## Not built

These need things a codebase can't supply, or they are later-phase plan items:
- **App-store publishing.** The mobile app is built and bundles for both platforms. Publishing needs your Google Play and Apple developer accounts, Firebase config files for push notifications, and real icons (see `mobile/README.md`).
- **Plan §9.5 rule "last to accept but unexplained high income":** off-app income isn't observable in platform data, so there is no honest way to automate this rule. Use the value-drop and cancel-without-rebook rules, plus manual review.
- **Automatic commission recovery** from pending payouts for confirmed off-app jobs. The plan says "where legally applicable", so this needs a lawyer's clause first. Today such a worker's payouts are held and an admin decides.
- **Aadhaar storage:** UIDAI rules require an Aadhaar Data Vault (or offline e-KYC/masked Aadhaar) for storing Aadhaar numbers. The number is encrypted here, but before launch consider collecting only masked Aadhaar or using DigiLocker/offline e-KYC.
- **Legal (§13):** business registration, GST, and payment-aggregator compliance via Razorpay. The legal texts in this repository are placeholders, not legal advice.
