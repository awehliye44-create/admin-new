-- Loaded by finalize_paid_booking_session_race.sh --with-ledger-trigger (after the function under
-- test). Adds the production payment_authorization_ledger and the session columns its trigger reads,
-- so the existing finalize race scenarios run with trg_payment_session_ledger_sync active.
SET search_path = public;

ALTER TABLE payment_sessions
  ADD COLUMN purpose text NOT NULL DEFAULT 'RIDE_BOOKING',
  ADD COLUMN authorised_at timestamptz,
  ADD COLUMN idempotency_key text;

CREATE FUNCTION race_default_session_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.idempotency_key := COALESCE(NEW.idempotency_key, 'preauth_' || NEW.client_action_id);
  RETURN NEW;
END $$;
CREATE TRIGGER race_default_session_key BEFORE INSERT ON payment_sessions
  FOR EACH ROW EXECUTE FUNCTION race_default_session_key();

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
