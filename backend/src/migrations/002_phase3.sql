-- Phase 3 (plan §2 and §12): cities and franchise operators, the
-- city-manager role, featured worker listings, the warranty add-on, and
-- sponsored brand placements.

-- ------------------------------------------------------------ cities
CREATE TABLE cities (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         TEXT NOT NULL UNIQUE,
  active                       BOOLEAN NOT NULL DEFAULT true,
  -- Franchise / city licensing (§2): a local operator runs the city for a
  -- share of the platform's commission earned there.
  franchise_operator           TEXT,
  franchise_revenue_share_bps  INT NOT NULL DEFAULT 0 CHECK (franchise_revenue_share_bps BETWEEN 0 AND 10000),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serviceable PIN codes. A booking or worker area outside these is refused.
CREATE TABLE city_pincodes (
  pincode  TEXT PRIMARY KEY CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  city_id  UUID NOT NULL REFERENCES cities(id)
);
CREATE INDEX ON city_pincodes (city_id);

ALTER TABLE bookings ADD COLUMN city_id UUID REFERENCES cities(id);
CREATE INDEX ON bookings (city_id, created_at DESC);

-- City managers (§4): an admin limited to some cities. NULL = all cities.
ALTER TABLE admin_accounts ADD COLUMN city_ids UUID[];

-- ------------------------------------------------------------ warranty
-- §2: a small fee for a 30-day service guarantee. 0 = not offered.
ALTER TABLE services ADD COLUMN warranty_fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (warranty_fee_paise >= 0);
ALTER TABLE bookings ADD COLUMN warranty_fee BIGINT NOT NULL DEFAULT 0 CHECK (warranty_fee >= 0);
ALTER TABLE bookings ADD COLUMN warranty_until TIMESTAMPTZ;
-- A free revisit under warranty points at the original (paid) booking.
ALTER TABLE bookings ADD COLUMN warranty_parent_id UUID REFERENCES bookings(id);
ALTER TABLE bookings DROP CONSTRAINT bookings_amount_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_amount_check
  CHECK (amount >= 0 AND (amount > 0 OR warranty_parent_id IS NOT NULL) AND warranty_fee <= amount);

-- ------------------------------------------------------------ featured
CREATE TABLE featured_plans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  days         INT NOT NULL CHECK (days BETWEEN 1 AND 365),
  price_paise  BIGINT NOT NULL CHECK (price_paise > 0),
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE featured_listings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id   UUID NOT NULL REFERENCES workers(id),
  plan_id     UUID NOT NULL REFERENCES featured_plans(id),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  days        INT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'active', 'cancelled')),
  starts_at   TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON featured_listings (worker_id, ends_at);

ALTER TABLE payments ADD COLUMN featured_listing_id UUID REFERENCES featured_listings(id);
ALTER TABLE payments DROP CONSTRAINT payments_check1;
ALTER TABLE payments ADD CONSTRAINT payments_one_purpose
  CHECK (num_nonnulls(booking_id, subscription_id, featured_listing_id) = 1);

-- ------------------------------------------------------------ advertising
CREATE TABLE ad_placements (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand                  TEXT NOT NULL,
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL DEFAULT '',
  -- Only https links chosen by an admin; clicks go through /api/ads/:id/click.
  link_url               TEXT NOT NULL CHECK (link_url ~ '^https://[^\s]+$'),
  slot                   TEXT NOT NULL CHECK (slot IN ('home_banner', 'booking_confirmed')),
  category               TEXT,
  city_id                UUID REFERENCES cities(id),
  image                  BYTEA,
  image_mime             TEXT,
  starts_on              DATE NOT NULL,
  ends_on                DATE NOT NULL,
  active                 BOOLEAN NOT NULL DEFAULT true,
  contract_amount_paise  BIGINT NOT NULL DEFAULT 0 CHECK (contract_amount_paise >= 0),
  impressions            BIGINT NOT NULL DEFAULT 0,
  clicks                 BIGINT NOT NULL DEFAULT 0,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

-- ------------------------------------------------------------ triggers
-- Same guard as 001, extended: a warranty revisit is covered by its
-- parent booking's captured payment.
CREATE OR REPLACE FUNCTION bookings_guard() RETURNS trigger AS $$
DECLARE
  allowed TEXT[];
  has_payment BOOLEAN;
BEGIN
  IF NEW.amount <> OLD.amount OR NEW.warranty_fee <> OLD.warranty_fee THEN
    RAISE EXCEPTION 'booking price is fixed at creation and cannot be changed';
  END IF;
  IF NEW.customer_id <> OLD.customer_id OR NEW.service_id <> OLD.service_id THEN
    RAISE EXCEPTION 'booking customer/service cannot be changed';
  END IF;
  IF NEW.completion_otp_enc <> OLD.completion_otp_enc THEN
    RAISE EXCEPTION 'completion OTP cannot be changed';
  END IF;
  IF NEW.warranty_parent_id IS DISTINCT FROM OLD.warranty_parent_id THEN
    RAISE EXCEPTION 'warranty link cannot be changed';
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

  IF NEW.status IN ('paid', 'assigned', 'in_progress', 'completed', 'confirmed') THEN
    SELECT EXISTS (
      SELECT 1 FROM payments p
       WHERE p.payment_status IN ('captured', 'partially_refunded')
         AND (p.booking_id = NEW.id
              OR (NEW.subscription_id IS NOT NULL AND p.subscription_id = NEW.subscription_id)
              OR (NEW.warranty_parent_id IS NOT NULL AND p.booking_id = NEW.warranty_parent_id))
    ) INTO has_payment;
    IF NOT has_payment THEN
      RAISE EXCEPTION 'booking % has no captured in-app payment', NEW.id;
    END IF;
  END IF;

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

CREATE OR REPLACE FUNCTION bookings_insert_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status NOT IN ('pending_payment', 'paid') THEN
    RAISE EXCEPTION 'bookings must be created as pending_payment (or paid, for prepaid visits)';
  END IF;
  IF NEW.status = 'paid' AND NEW.subscription_id IS NULL AND NEW.warranty_parent_id IS NULL THEN
    RAISE EXCEPTION 'only subscription visits and warranty revisits may be created already paid';
  END IF;
  IF NEW.warranty_parent_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM bookings p WHERE p.id = NEW.warranty_parent_id
          AND p.warranty_until IS NOT NULL AND p.warranty_until > now()) THEN
    RAISE EXCEPTION 'warranty revisit requires a parent booking under active warranty';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
