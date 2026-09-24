-- SevaSetu (hyperlocal services marketplace) — initial schema.
--
-- Money is stored as integer paise (BIGINT) everywhere; rates as basis
-- points (1 bp = 0.01%). No floating point touches money.
--
-- Several of the plan's controls are enforced here in the database, not
-- only in application code, so that a bug or a compromised admin session
-- cannot bypass them:
--   * a booking cannot reach in_progress/completed/confirmed without a
--     captured in-app payment (Section 9.1)
--   * a booking cannot be completed without GPS check-in and customer OTP
--     (Sections 9.2, 9.3)
--   * price cannot change after the booking is created (Section 9.1)
--   * status transitions follow a fixed state machine (Section 7.1)
--   * audit_logs is append-only and hash-chained (Section 9.8)
--   * maker-checker: requester and approver must differ (Section 9.8)

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role          TEXT NOT NULL CHECK (role IN ('customer', 'worker', 'admin')),
  name          TEXT,
  -- Phone is PII: stored AES-256-GCM encrypted. phone_hash is a keyed
  -- HMAC used only for lookup/uniqueness, never reversible.
  phone_enc     BYTEA,
  phone_hash    BYTEA,
  phone_last4   TEXT,
  email         TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'deactivated', 'deleted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A phone number maps to exactly one account per role.
  UNIQUE (phone_hash, role),
  CHECK (role = 'admin' OR phone_hash IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_admin_uniq ON users (lower(email)) WHERE role = 'admin';

CREATE TABLE admin_accounts (
  user_id           UUID PRIMARY KEY REFERENCES users(id),
  password_hash     TEXT NOT NULL,
  totp_secret_enc   BYTEA,
  totp_enabled      BOOLEAN NOT NULL DEFAULT false,
  last_totp_step    BIGINT,
  failed_attempts   INT NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  permissions       TEXT[] NOT NULL DEFAULT '{}',
  -- Access grants are maker-checker: requested permissions sit here
  -- until a different admin approves them.
  pending_permissions   TEXT[],
  pending_requested_by  UUID REFERENCES users(id),
  created_by        UUID REFERENCES users(id),
  last_login_at     TIMESTAMPTZ,
  access_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_login_attempts (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  user_id     UUID REFERENCES users(id),
  success     BOOLEAN NOT NULL,
  stage       TEXT NOT NULL,         -- 'password' | 'totp'
  reason      TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON admin_login_attempts (created_at DESC);

CREATE TABLE sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  role                TEXT NOT NULL,
  family_id           UUID NOT NULL,
  refresh_hash        BYTEA NOT NULL UNIQUE,
  expires_at          TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at          TIMESTAMPTZ,
  revoke_reason       TEXT,
  replaced_by         UUID,
  -- admin sessions created before TOTP verification are 'pending_2fa'
  -- and can only call the 2FA endpoints.
  mfa_satisfied       BOOLEAN NOT NULL DEFAULT true,
  ip_address          TEXT,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (family_id);

CREATE TABLE otp_requests (
  id           BIGSERIAL PRIMARY KEY,
  phone_hash   BYTEA NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('customer', 'worker')),
  code_hash    BYTEA NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INT NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON otp_requests (phone_hash, created_at DESC);

CREATE TABLE consents (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  purpose         TEXT NOT NULL,
  policy_version  TEXT NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at    TIMESTAMPTZ,
  ip_address      TEXT
);

CREATE TABLE data_requests (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('export', 'deletion')),
  status        TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'rejected')),
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE workers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL UNIQUE REFERENCES users(id),
  skill_category        TEXT,
  service_area_pincode  TEXT,
  kyc_status            TEXT NOT NULL DEFAULT 'not_submitted'
                        CHECK (kyc_status IN ('not_submitted', 'under_review', 'approved', 'rejected')),
  kyc_rejection_reason  TEXT,
  id_type               TEXT,
  id_number_enc         BYTEA,
  id_last4              TEXT,
  -- Bank/UPI details are NEVER stored. Only the provider's fund-account
  -- token (after penny-drop verification) and a masked display string.
  payout_ref_token      TEXT,
  payout_method         TEXT CHECK (payout_method IN ('bank_account', 'vpa')),
  payout_masked         TEXT,
  payout_verified_at    TIMESTAMPTZ,
  commission_rate_bps   INT NOT NULL DEFAULT 2000 CHECK (commission_rate_bps BETWEEN 0 AND 5000),
  rating_avg            NUMERIC(3, 2) NOT NULL DEFAULT 0,
  rating_count          INT NOT NULL DEFAULT 0,
  total_jobs            INT NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'deactivated')),
  suspended_until       TIMESTAMPTZ,
  strikes               INT NOT NULL DEFAULT 0,
  policy_ack_version    TEXT,
  policy_ack_at         TIMESTAMPTZ,
  payout_hold           BOOLEAN NOT NULL DEFAULT false,
  payout_hold_reason    TEXT,
  monitoring_until      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON workers (service_area_pincode, skill_category) WHERE kyc_status = 'approved';

CREATE TABLE kyc_documents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    UUID NOT NULL REFERENCES workers(id),
  doc_type     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INT NOT NULL,
  sha256       TEXT NOT NULL,
  content_enc  BYTEA NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_acknowledgements (
  id              BIGSERIAL PRIMARY KEY,
  worker_id       UUID NOT NULL REFERENCES workers(id),
  policy_version  TEXT NOT NULL,
  policy_sha256   TEXT NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  fixed_price_paise   BIGINT NOT NULL CHECK (fixed_price_paise > 0),
  duration_minutes    INT NOT NULL CHECK (duration_minutes > 0),
  description         TEXT NOT NULL DEFAULT '',
  urgent_premium_bps  INT NOT NULL DEFAULT 2500 CHECK (urgent_premium_bps BETWEEN 0 AND 10000),
  active              BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  label        TEXT NOT NULL DEFAULT 'Home',
  details_enc  BYTEA NOT NULL,          -- street lines, encrypted
  city         TEXT NOT NULL,
  pincode      TEXT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES users(id),
  service_id        UUID NOT NULL REFERENCES services(id),
  address_id        UUID NOT NULL REFERENCES addresses(id),
  frequency         TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'half_yearly')),
  visits_total      INT NOT NULL CHECK (visits_total BETWEEN 1 AND 12),
  visits_generated  INT NOT NULL DEFAULT 0,
  preferred_hour    INT NOT NULL CHECK (preferred_hour BETWEEN 7 AND 20),
  next_due_date     DATE NOT NULL,
  per_visit_paise   BIGINT NOT NULL CHECK (per_visit_paise > 0),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  status            TEXT NOT NULL DEFAULT 'pending_payment'
                    CHECK (status IN ('pending_payment', 'active', 'completed', 'cancelled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount = per_visit_paise * visits_total)
);

CREATE TABLE bookings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES users(id),
  worker_id             UUID REFERENCES workers(id),
  service_id            UUID NOT NULL REFERENCES services(id),
  subscription_id       UUID REFERENCES subscriptions(id),
  address_id            UUID NOT NULL REFERENCES addresses(id),
  address_enc           BYTEA NOT NULL,           -- snapshot at booking time
  pincode               TEXT NOT NULL,
  lat                   DOUBLE PRECISION NOT NULL,
  lng                   DOUBLE PRECISION NOT NULL,
  scheduled_time        TIMESTAMPTZ NOT NULL,
  is_urgent             BOOLEAN NOT NULL DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                          'pending_payment', 'paid', 'assigned', 'in_progress',
                          'completed', 'confirmed', 'disputed', 'cancelled', 'refunded')),
  amount                BIGINT NOT NULL CHECK (amount > 0),
  commission_rate_bps   INT,
  commission_amount     BIGINT,
  worker_payout         BIGINT,
  completion_otp_enc    BYTEA NOT NULL,
  completion_otp_attempts INT NOT NULL DEFAULT 0,
  paid_at               TIMESTAMPTZ,
  accepted_at           TIMESTAMPTZ,
  checkin_at            TIMESTAMPTZ,
  checkin_distance_m    INT,
  checkout_at           TIMESTAMPTZ,
  checkout_distance_m   INT,
  otp_verified_at       TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  confirmed_at          TIMESTAMPTZ,
  auto_confirmed        BOOLEAN NOT NULL DEFAULT false,
  cancelled_at          TIMESTAMPTZ,
  cancelled_by_role     TEXT,
  cancel_reason         TEXT,
  reconciliation_status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (reconciliation_status IN ('pending', 'clean', 'mismatch')),
  reconciled_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (commission_amount IS NULL OR (commission_amount >= 0 AND worker_payout >= 0
         AND commission_amount + worker_payout = amount))
);
CREATE INDEX ON bookings (customer_id, created_at DESC);
CREATE INDEX ON bookings (worker_id, created_at DESC);
CREATE INDEX ON bookings (status, pincode);

CREATE TABLE booking_events (
  id          BIGSERIAL PRIMARY KEY,
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    UUID,
  actor_role  TEXT NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON booking_events (booking_id, id);

CREATE TABLE booking_declines (
  booking_id  UUID NOT NULL REFERENCES bookings(id),
  worker_id   UUID NOT NULL REFERENCES workers(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, worker_id)
);

CREATE TABLE gps_pings (
  id           BIGSERIAL PRIMARY KEY,
  booking_id   UUID NOT NULL REFERENCES bookings(id),
  worker_id    UUID NOT NULL REFERENCES workers(id),
  kind         TEXT NOT NULL CHECK (kind IN ('checkin', 'checkout', 'checkin_rejected')),
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  accuracy_m   INT,
  distance_m   INT NOT NULL,
  is_mock      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON gps_pings (worker_id, created_at DESC);

CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id       UUID REFERENCES bookings(id),
  subscription_id  UUID REFERENCES subscriptions(id),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL DEFAULT 'INR',
  gateway          TEXT NOT NULL,
  gateway_order_id TEXT NOT NULL UNIQUE,
  gateway_txn_id   TEXT UNIQUE,
  payment_status   TEXT NOT NULL DEFAULT 'created'
                   CHECK (payment_status IN ('created', 'captured', 'failed', 'refunded', 'partially_refunded')),
  refunded_amount  BIGINT NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((booking_id IS NULL) <> (subscription_id IS NULL))
);
CREATE INDEX ON payments (booking_id);
CREATE INDEX ON payments (subscription_id);

CREATE TABLE payout_batches (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start          DATE NOT NULL,
  week_end            DATE NOT NULL,
  total_amount        BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'approved', 'released', 'cancelled')),
  required_approvals  INT NOT NULL CHECK (required_approvals BETWEEN 1 AND 2),
  prepared_by         UUID NOT NULL REFERENCES users(id),
  released_by         UUID REFERENCES users(id),
  released_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payout_batches_week_uniq ON payout_batches (week_start) WHERE status <> 'cancelled';

CREATE TABLE payout_batch_approvals (
  batch_id    UUID NOT NULL REFERENCES payout_batches(id),
  admin_id    UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, admin_id)
);

CREATE TABLE payouts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           UUID NOT NULL REFERENCES payout_batches(id),
  worker_id          UUID NOT NULL REFERENCES workers(id),
  week_start         DATE NOT NULL,
  week_end           DATE NOT NULL,
  total_amount       BIGINT NOT NULL CHECK (total_amount > 0),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  gateway_payout_id  TEXT UNIQUE,
  utr_number         TEXT,
  failure_reason     TEXT,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, worker_id)
);

-- One ledger line per confirmed booking: what the worker is owed for it.
CREATE TABLE payout_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID NOT NULL UNIQUE REFERENCES bookings(id),
  worker_id    UUID NOT NULL REFERENCES workers(id),
  amount       BIGINT NOT NULL CHECK (amount >= 0),
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'held', 'batched', 'paid', 'cancelled')),
  hold_reason  TEXT,
  payout_id    UUID REFERENCES payouts(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON payout_items (worker_id, status);

CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  worker_id   UUID NOT NULL REFERENCES workers(id),
  rating      INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  asked_for_cash BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID NOT NULL REFERENCES bookings(id),
  raised_by    UUID NOT NULL REFERENCES users(id),
  reason       TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  previous_booking_status TEXT NOT NULL,
  resolution   TEXT,
  resolved_by  UUID REFERENCES users(id),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX disputes_one_open ON disputes (booking_id) WHERE status = 'open';

CREATE TABLE refund_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID NOT NULL REFERENCES bookings(id),
  payment_id         UUID NOT NULL REFERENCES payments(id),
  dispute_id         UUID REFERENCES disputes(id),
  amount             BIGINT NOT NULL CHECK (amount > 0),
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested', 'approved', 'rejected', 'processed', 'failed')),
  requested_by       UUID REFERENCES users(id),     -- NULL = system (e.g. customer cancellation)
  approved_by        UUID REFERENCES users(id),
  gateway_refund_id  TEXT,
  failure_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at       TIMESTAMPTZ,
  CHECK (approved_by IS NULL OR requested_by IS NULL OR approved_by <> requested_by)
);

CREATE TABLE cash_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   UUID NOT NULL REFERENCES bookings(id),
  customer_id  UUID NOT NULL REFERENCES users(id),
  worker_id    UUID NOT NULL REFERENCES workers(id),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (booking_id, customer_id)
);

CREATE TABLE messages (
  id           BIGSERIAL PRIMARY KEY,
  booking_id   UUID NOT NULL REFERENCES bookings(id),
  sender_id    UUID NOT NULL REFERENCES users(id),
  sender_role  TEXT NOT NULL,
  body         TEXT NOT NULL,
  redacted     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (booking_id, id);

CREATE TABLE masked_calls (
  id                BIGSERIAL PRIMARY KEY,
  booking_id        UUID NOT NULL REFERENCES bookings(id),
  initiated_by_role TEXT NOT NULL,
  customer_id       UUID NOT NULL REFERENCES users(id),
  worker_id         UUID NOT NULL REFERENCES workers(id),
  provider_call_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON masked_calls (customer_id, worker_id, created_at);

CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, id DESC);

CREATE TABLE device_tokens (
  user_id     UUID NOT NULL REFERENCES users(id),
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);

CREATE TABLE fraud_flags (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    UUID REFERENCES workers(id),
  customer_id  UUID REFERENCES users(id),
  booking_id   UUID REFERENCES bookings(id),
  flag_type    TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  details      JSONB NOT NULL DEFAULT '{}',
  reviewed_by  UUID REFERENCES users(id),
  reviewed_at  TIMESTAMPTZ,
  review_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- De-duplicate: at most one open flag of a type per (worker, booking, customer).
CREATE UNIQUE INDEX fraud_flags_open_uniq ON fraud_flags (
  flag_type,
  COALESCE(worker_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(booking_id, '00000000-0000-0000-0000-000000000000'),
  COALESCE(customer_id, '00000000-0000-0000-0000-000000000000')
) WHERE status = 'open';

CREATE TABLE strikes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id      UUID NOT NULL REFERENCES workers(id),
  violation      TEXT NOT NULL CHECK (violation IN (
                   'cash_demand', 'off_app_diversion', 'minor_mismatch', 'gps_tampering')),
  fraud_flag_id  UUID REFERENCES fraud_flags(id),
  action_taken   TEXT NOT NULL,
  issued_by      UUID REFERENCES users(id),     -- NULL = automated
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE change_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('commission_rate', 'worker_reactivation', 'payout_hold_release')),
  target_id     UUID NOT NULL,
  old_value     JSONB NOT NULL,
  new_value     JSONB NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by  UUID NOT NULL REFERENCES users(id),
  reviewed_by   UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);

CREATE TABLE job_runs (
  id           BIGSERIAL PRIMARY KEY,
  job          TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  summary      JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE webhook_events (
  id           TEXT PRIMARY KEY,         -- provider event id, for idempotency
  provider     TEXT NOT NULL,
  event        TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Audit log: append-only and hash-chained.
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      UUID,
  actor_role    TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_table  TEXT,
  target_id     TEXT,
  old_value     JSONB,
  new_value     JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  prev_hash     TEXT NOT NULL,
  row_hash      TEXT NOT NULL
);
CREATE INDEX ON audit_logs (target_table, target_id);
CREATE INDEX ON audit_logs (actor_id, id DESC);

CREATE FUNCTION audit_logs_chain() RETURNS trigger AS $$
DECLARE
  last_hash TEXT;
BEGIN
  -- Serialise writers so the chain is strictly linear.
  PERFORM pg_advisory_xact_lock(hashtext('audit_logs_chain'));
  SELECT row_hash INTO last_hash FROM audit_logs ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.created_at := clock_timestamp();
  NEW.row_hash := encode(sha256(convert_to(
      NEW.prev_hash || '|' || NEW.id || '|' || COALESCE(NEW.actor_id::text, '') || '|' ||
      NEW.actor_role || '|' || NEW.action || '|' || COALESCE(NEW.target_table, '') || '|' ||
      COALESCE(NEW.target_id, '') || '|' || COALESCE(NEW.old_value::text, '') || '|' ||
      COALESCE(NEW.new_value::text, '') || '|' || COALESCE(NEW.ip_address, '') || '|' ||
      to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();

CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- ---------------------------------------------------------------------
-- Booking integrity.
-- ---------------------------------------------------------------------
CREATE FUNCTION bookings_guard() RETURNS trigger AS $$
DECLARE
  allowed TEXT[];
  has_payment BOOLEAN;
BEGIN
  IF NEW.amount <> OLD.amount THEN
    RAISE EXCEPTION 'booking price is fixed at creation and cannot be changed';
  END IF;
  IF NEW.customer_id <> OLD.customer_id OR NEW.service_id <> OLD.service_id THEN
    RAISE EXCEPTION 'booking customer/service cannot be changed';
  END IF;
  IF NEW.completion_otp_enc <> OLD.completion_otp_enc THEN
    RAISE EXCEPTION 'completion OTP cannot be changed';
  END IF;

  IF NEW.status <> OLD.status THEN
    allowed := CASE OLD.status
      WHEN 'pending_payment' THEN ARRAY['paid', 'cancelled']
      WHEN 'paid'            THEN ARRAY['assigned', 'cancelled']
      WHEN 'assigned'        THEN ARRAY['paid', 'in_progress', 'cancelled']
      WHEN 'in_progress'     THEN ARRAY['paid', 'completed', 'disputed']
      WHEN 'completed'       THEN ARRAY['confirmed', 'disputed']
      WHEN 'confirmed'       THEN ARRAY['disputed']
      WHEN 'disputed'        THEN ARRAY['confirmed', 'completed', 'refunded', 'cancelled']
      WHEN 'cancelled'       THEN ARRAY['refunded']
      ELSE ARRAY[]::TEXT[]
    END;
    IF NOT (NEW.status = ANY (allowed)) THEN
      RAISE EXCEPTION 'illegal booking transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;

  -- Section 9.1: no job progresses without a captured in-app payment.
  IF NEW.status IN ('paid', 'assigned', 'in_progress', 'completed', 'confirmed') THEN
    SELECT EXISTS (
      SELECT 1 FROM payments p
       WHERE p.payment_status IN ('captured', 'partially_refunded')
         AND (p.booking_id = NEW.id
              OR (NEW.subscription_id IS NOT NULL AND p.subscription_id = NEW.subscription_id))
    ) INTO has_payment;
    IF NOT has_payment THEN
      RAISE EXCEPTION 'booking % has no captured in-app payment', NEW.id;
    END IF;
  END IF;

  -- Sections 9.2 / 9.3: completion needs GPS check-in and customer OTP.
  IF NEW.status = 'completed' AND OLD.status = 'in_progress' THEN
    IF NEW.checkin_at IS NULL OR NEW.otp_verified_at IS NULL OR NEW.worker_id IS NULL THEN
      RAISE EXCEPTION 'booking cannot complete without GPS check-in and customer OTP';
    END IF;
  END IF;
  IF NEW.status = 'in_progress' AND NEW.checkin_at IS NULL THEN
    RAISE EXCEPTION 'booking cannot start without GPS check-in';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_guard BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_guard();

CREATE FUNCTION bookings_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status NOT IN ('pending_payment', 'paid') THEN
    RAISE EXCEPTION 'bookings must be created as pending_payment (or paid, for prepaid subscriptions)';
  END IF;
  IF NEW.status = 'paid' AND NEW.subscription_id IS NULL THEN
    RAISE EXCEPTION 'only subscription visits may be created already paid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_insert_guard BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_insert_guard();

-- Payout ledger lines can only be paid via a payout record.
CREATE FUNCTION payout_items_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.amount <> OLD.amount AND OLD.status IN ('batched', 'paid') THEN
    RAISE EXCEPTION 'cannot change amount of a batched/paid payout item';
  END IF;
  IF NEW.status = 'paid' AND NEW.payout_id IS NULL THEN
    RAISE EXCEPTION 'paid payout item must reference a payout';
  END IF;
  IF OLD.status = 'paid' AND NEW.status <> 'paid' THEN
    RAISE EXCEPTION 'paid payout items are final';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payout_items_guard BEFORE UPDATE ON payout_items
  FOR EACH ROW EXECUTE FUNCTION payout_items_guard();

-- Maker-checker for payout batches: the preparer can never approve.
CREATE FUNCTION payout_approvals_guard() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM payout_batches WHERE id = NEW.batch_id AND prepared_by = NEW.admin_id) THEN
    RAISE EXCEPTION 'the admin who prepared a payout batch cannot approve it';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payout_approvals_guard BEFORE INSERT ON payout_batch_approvals
  FOR EACH ROW EXECUTE FUNCTION payout_approvals_guard();
