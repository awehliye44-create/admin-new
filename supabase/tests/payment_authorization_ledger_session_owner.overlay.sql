-- LOCAL-ONLY overlay for payment_authorization_ledger_session_owner.sh. Never run against production.
-- Loaded after finalize_paid_booking_session_race.schema.sql. Brings payment_sessions and
-- payment_authorization_ledger to their production column types (catalog, 2026-10-02).
SET search_path = public;
-- Helpers below reference columns the migration under test adds.
SET check_function_bodies = off;

CREATE TYPE payment_session_status AS ENUM (
  'pending_payment','payment_authorised','trip_created','payment_orphaned','failed','cancelled',
  'authorising','authorised_hold','dispatching','completed_pending_capture','captured','released',
  'orphan_authorisation','payment_shortfall','migrated_evidence','legacy_unknown',
  'ADDITIONAL_AUTHORISATION_REQUIRED','ADDITIONAL_AUTHORISATION_PENDING','ADDITIONAL_AUTHORISATION_CONFIRMED',
  'CAPTURE_LIMIT_EXCEEDED','PARTIAL_CAPTURE_ONLY','PAYMENT_RECOVERY_REQUIRED','CAPTURE_CONFIRMED',
  'RECOVERY_CHECKOUT_CREATED','CUSTOMER_ACTION_REQUIRED','RECOVERY_COMPLETED','RECOVERY_DECLINED',
  'RECOVERY_CANCELLED','RECOVERY_EXPIRED'
);
CREATE TYPE payment_session_purpose AS ENUM ('RIDE_BOOKING','SAVE_CARD','PAYMENT_RECOVERY','LEGACY_EVIDENCE');

ALTER TABLE payment_sessions
  ALTER COLUMN client_action_id SET NOT NULL,
  ALTER COLUMN payment_provider SET DEFAULT 'revolut',
  ALTER COLUMN payment_provider SET NOT NULL,
  ALTER COLUMN status TYPE payment_session_status USING 'pending_payment'::payment_session_status,
  ALTER COLUMN status SET DEFAULT 'pending_payment',
  ALTER COLUMN status SET NOT NULL,
  ADD COLUMN user_id uuid,
  ADD COLUMN authorised_at timestamptz,
  ADD COLUMN idempotency_key text NOT NULL,
  ADD COLUMN purpose payment_session_purpose NOT NULL DEFAULT 'RIDE_BOOKING',
  ADD CONSTRAINT payment_sessions_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX payment_sessions_provider_idempotency_unique_idx
  ON payment_sessions (payment_provider, idempotency_key);
CREATE UNIQUE INDEX payment_sessions_provider_order_unique_idx
  ON payment_sessions (payment_provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL AND btrim(provider_order_id) <> '';

-- Verbatim production DDL (pg_constraint / pg_indexes / pg_policy, 2026-10-02).
CREATE TABLE payment_authorization_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  fare_revision_number integer NOT NULL DEFAULT 0,
  operation text NOT NULL CHECK (operation = ANY (ARRAY['initial_auth','top_up','capture'])),
  idempotency_key text NOT NULL UNIQUE,
  amount_pence integer NOT NULL CHECK (amount_pence >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','succeeded','failed','skipped'])),
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_authorization_ledger_trip_operation_status_idx
  ON payment_authorization_ledger (trip_id, operation, status);
CREATE INDEX payment_authorization_ledger_trip_revision_idx
  ON payment_authorization_ledger (trip_id, fare_revision_number);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;
ALTER TABLE payment_authorization_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_role_all ON payment_authorization_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT SELECT, UPDATE ON payment_sessions TO authenticated;

-- Payment-first booking: session row linked to a fresh Revolut order, not authorised yet.
CREATE FUNCTION mk_pending(p_id uuid, p_cai text, p_order text, p_customer uuid,
                           p_purpose payment_session_purpose DEFAULT 'RIDE_BOOKING') RETURNS void LANGUAGE sql AS $$
  INSERT INTO payment_sessions (id, client_action_id, user_id, customer_id, service_area_id, payment_provider,
    provider_order_id, status, authorised_amount_pence, estimated_total_pence, buffer_pence, booking_snapshot,
    payment_method, currency, provider_state, metadata, updated_at, idempotency_key, purpose)
  VALUES (p_id, p_cai, p_customer, p_customer, '00000000-0000-0000-0000-00000000a5a5', 'revolut', p_order,
    'pending_payment', 750, 500, 250,
    jsonb_build_object('passenger_id', p_customer, 'fare_pence', 500, 'buffer_pence', 250,
      'pickup', jsonb_build_object('address','A','lat',52.0,'lng',-0.7),
      'dropoff', jsonb_build_object('address','B','lat',52.1,'lng',-0.8), 'payment_method','CARD'),
    'card', 'GBP', 'PENDING', '{}'::jsonb, now(), 'preauth_' || p_cai, p_purpose);
$$;

-- create-preauth: recordPaymentAuthorizationEvent after the order link (session owner, no trip).
CREATE FUNCTION preauth_ledger(p_session uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO payment_authorization_ledger (trip_id, payment_session_id, provider_order_id, fare_revision_number,
    operation, idempotency_key, amount_pence, status, metadata)
  SELECT NULL, s.id, s.provider_order_id, 0, 'initial_auth', s.idempotency_key, 750, 'pending',
    jsonb_build_object('provider','revolut','client_action_id',s.client_action_id,'provider_order_id',s.provider_order_id,
      'payment_session_id', s.id)
  FROM payment_sessions s WHERE s.id = p_session;
$$;

-- confirm / revolut-webhook: markPaymentSessionAuthorised after a provider read.
CREATE FUNCTION authorise(p_session uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE payment_sessions SET status='authorised_hold', provider_state='AUTHORISED', authorised_at=now(), updated_at=now()
   WHERE id = p_session;
$$;

-- create-trip-after-payment post-commit ledger write: trip-owned, no session column, session key.
CREATE FUNCTION ctap_ledger(p_session uuid, p_trip uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO payment_authorization_ledger (trip_id, fare_revision_number, operation, idempotency_key,
    amount_pence, status, metadata)
  SELECT p_trip, 0, 'initial_auth', 'preauth_' || s.client_action_id, 750, 'succeeded',
    jsonb_build_object('provider','revolut','provider_order_id',s.provider_order_id,
      'client_action_id', s.client_action_id, 'payment_session_id', s.id)
  FROM payment_sessions s WHERE s.id = p_session;
$$;

-- markPaymentSessionDispatching (CTAP): status + trip link, authorised_at untouched.
CREATE FUNCTION ctap_dispatching(p_session uuid, p_trip uuid) RETURNS void LANGUAGE sql AS $$
  UPDATE payment_sessions SET status='dispatching', trip_id=p_trip, updated_at=now() WHERE id = p_session;
$$;
