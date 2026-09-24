# Deploy SevaSetu free on Koyeb + Neon (no card)

A free setup that doesn't ask for a payment card. It uses:
- **Koyeb**: one free server running the customer and worker app at `/` and the admin panel at `/ops/`;
- **Neon**: a free PostgreSQL database.

> **Free-tier limits:**
> - The Koyeb free server sleeps after about an hour without visitors, and the first visit afterwards takes a few seconds.
> - Free servers run in Frankfurt or Washington, not India. Pick **Frankfurt** (closest), with the database in the same region.
> - The admin panel shares the app's address (`/ops/`) instead of a separate subdomain. It's still protected by password + 2FA, hidden from search engines, and every action is audited.
> - Pay-as-you-go costs remain for real use: MSG91 per SMS, Exotel per call, Razorpay about 2% per payment.
>
> Move to paid hosting (or Oracle Cloud in India: `deploy/oracle/`) once you have regular customers.

## 1. Database: Neon (free, no card)

1. Sign up at **https://neon.tech** (GitHub or Google login).
2. Create a project named `sevasetu`, Postgres 16, region **AWS Europe Central 1 (Frankfurt)**.
3. On the dashboard, click **Connect**, turn **Connection pooling OFF**, and copy the connection string. It starts with `postgresql://` and ends with `sslmode=require`. Keep it private.

## 2. Secret keys

You need three random secrets: `JWT_SECRET`, `PII_ENCRYPTION_KEY` and `LOOKUP_HMAC_KEY`. Generate them on your own computer, for example:

```bash
openssl rand -base64 32     # run three times, one value per key
```

Or use the SevaSetu key generator page, which creates them in your browser without sending them anywhere. Store all three in a password manager: **losing `PII_ENCRYPTION_KEY` makes stored customer data unreadable.**

## 3. App: Koyeb (free, no card)

1. Sign up at **https://app.koyeb.com/auth/signup** with GitHub, and allow Koyeb to read the **SevaSetu** repository.
2. **Create Service → Web service → GitHub →** choose `SevaSetu`, branch `main`.
3. **Builder:** choose **Dockerfile**, and set the Dockerfile location to `deploy/Dockerfile` (leave the work directory empty: the repository root).
4. **Instance:** **Free**. **Region:** **Frankfurt**.
5. **Ports:** `4000`, protocol HTTP, path `/`. **Health check:** HTTP on port 4000, path `/api/health`.
6. **Service name:** `sevasetu`. Koyeb shows your public URL, e.g. `https://sevasetu-<yourname>.koyeb.app`; you need it below.
7. **Environment variables.** Add each one. For those marked 🔒, choose type **Secret** so the value is stored encrypted and hidden.

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SERVE_FRONTEND` | `all` |
| `RUN_SCHEDULER` | `true` |
| `TRUST_PROXY_HOPS` | `all` |
| `CORS_ORIGINS` | your Koyeb URL, e.g. `https://sevasetu-yourname.koyeb.app` (no trailing slash) |
| `DATABASE_URL` 🔒 | the Neon connection string |
| `JWT_SECRET` 🔒 | secret #1 |
| `PII_ENCRYPTION_KEY` 🔒 | secret #2 |
| `LOOKUP_HMAC_KEY` 🔒 | secret #3 |
| `PAYMENT_PROVIDER` | `razorpay` |
| `RAZORPAY_KEY_ID` 🔒 | from Razorpay → API Keys |
| `RAZORPAY_KEY_SECRET` 🔒 | from Razorpay → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` 🔒 | a password you make up (also entered in Razorpay's webhook) |
| `RAZORPAYX_ACCOUNT_NUMBER` 🔒 | from RazorpayX |
| `SMS_PROVIDER` | `msg91` |
| `MSG91_AUTH_KEY` 🔒 | from MSG91 |
| `MSG91_OTP_TEMPLATE_ID` | your DLT-approved OTP template ID |
| `CALL_PROVIDER` | `exotel` |
| `EXOTEL_SID` 🔒, `EXOTEL_API_KEY` 🔒, `EXOTEL_API_TOKEN` 🔒 | from Exotel |
| `EXOTEL_CALLER_ID` | your ExoPhone number |
| `BOOTSTRAP_OPS_EMAIL` | operations admin email |
| `BOOTSTRAP_OPS_PASSWORD` 🔒 | 12+ characters, mixing upper/lower case, digits, symbols |
| `BOOTSTRAP_FINANCE_EMAIL` | finance admin email (a different person) |
| `BOOTSTRAP_FINANCE_PASSWORD` 🔒 | as above |

8. Click **Deploy**. The first build takes about 5–10 minutes. If a value is missing or unsafe, the app refuses to start, and the **Logs** tab says exactly which one.

## 4. After it's running

- **Customer and worker app:** `https://<your-koyeb-url>/`
- **Admin panel:** `https://<your-koyeb-url>/ops/`. Both admins sign in and set up 2FA with an authenticator app. Then add your city and PIN codes under **Cities & franchises**, and services and prices under **Services & pricing**.
- **Razorpay webhook:** in Razorpay Dashboard → Webhooks, add `https://<your-koyeb-url>/api/webhooks/razorpay` for `payment.captured`, `order.paid` and `payout.*` events, with your `RAZORPAY_WEBHOOK_SECRET`.
- **Mobile app:** set `EXPO_PUBLIC_API_URL` in `mobile/eas.json` to your Koyeb URL.
- **Backups:** Neon's free plan keeps a short restore window. Before real customers, take regular exports or move to a paid plan, and **test a restore** (plan §10).

Background jobs (auto-confirm, subscriptions, nightly payment reconciliation) run inside the app. If it was asleep at 02:00 IST, the nightly checks run as soon as it wakes.
