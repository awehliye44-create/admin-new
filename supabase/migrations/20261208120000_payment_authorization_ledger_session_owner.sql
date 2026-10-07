-- payment_authorization_ledger: session-owned initial authorisation.
--
-- Payment-first booking authorises a Revolut order BEFORE a trip exists, but the
-- ledger could only be owned by a trip (trip_id NOT NULL + FK). The pre-trip write
-- (trip_id = client_action_id) violated the FK on every booking, and trips created by
-- finalize_paid_booking_session never wrote a row, so initial_auth rows stopped on
-- 2026-09-18 when create-trip-after-payment stopped inserting trips.
--
-- Owner model after this migration:
--   * initial_auth rows are owned by the payment session (payment_session_id, FK
--     RESTRICT). trip_id is NULL until the trip exists and is stamped in the SAME
--     transaction that links the session to the trip.
--   * every other operation keeps a real trip_id (owner CHECK).
--   * one initial_auth row per payment session (partial unique index).
--   * idempotency_key for a session-owned row is the session's own idempotency_key
--     (preauth_<client_action_id> for payment-first bookings), shared by
--     create-preauth, create-trip-after-payment and this trigger.
--
-- trg_payment_session_ledger_sync derives the initial_auth lifecycle from
-- payment_sessions, so every writer (confirm, revolut-webhook, finalize RPC,
-- create-trip-after-payment, create-preauth) records it atomically with the session
-- state. It never writes payment_sessions, trips or provider state. A ledger failure
-- aborts the session write (fail closed); it is never swallowed.
--
-- The trips FK (ON DELETE CASCADE) is unchanged.
-- Certified by supabase/tests/payment_authorization_ledger_session_owner.sh.
-- Rollback: migrations/rollback/rollback_20261208120000_payment_authorization_ledger_session_owner.sql

ALTER TABLE public.payment_authorization_ledger
  ADD COLUMN IF NOT EXISTS payment_session_id uuid
    REFERENCES public.payment_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider_order_id text;

ALTER TABLE public.payment_authorization_ledger
  ALTER COLUMN trip_id DROP NOT NULL;

ALTER TABLE public.payment_authorization_ledger
  DROP CONSTRAINT IF EXISTS payment_authorization_ledger_owner_chk;
ALTER TABLE public.payment_authorization_ledger
  ADD CONSTRAINT payment_authorization_ledger_owner_chk CHECK (
    trip_id IS NOT NULL
    OR (operation = 'initial_auth' AND payment_session_id IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS payment_authorization_ledger_session_initial_auth_uidx
  ON public.payment_authorization_ledger (payment_session_id)
  WHERE operation = 'initial_auth' AND payment_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_authorization_ledger_provider_order_idx
  ON public.payment_authorization_ledger (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

COMMENT ON COLUMN public.payment_authorization_ledger.trip_id IS
  'Real trip. NULL only for a session-owned initial_auth whose trip does not exist yet; stamped when the payment session is linked to its trip.';
COMMENT ON COLUMN public.payment_authorization_ledger.payment_session_id IS
  'Owning payment session for initial_auth. Exists before the trip.';
COMMENT ON COLUMN public.payment_authorization_ledger.provider_order_id IS
  'Revolut order authorised by this row. Never changed after the first link (completion re-holds live in payment_session_authorisations).';

-- Authorisation evidence on a payment session row. authorised_at alone is not
-- reliable (dispatching / authorised_hold rows exist with authorised_at NULL).
CREATE OR REPLACE FUNCTION public.payment_session_has_authorisation_evidence(
  p_status text,
  p_authorised_at timestamptz,
  p_provider_state text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_authorised_at IS NOT NULL
    OR p_status = ANY (ARRAY[
      'payment_authorised', 'authorised_hold', 'trip_created', 'dispatching',
      'completed_pending_capture', 'captured', 'released', 'orphan_authorisation',
      'payment_shortfall', 'ADDITIONAL_AUTHORISATION_REQUIRED',
      'ADDITIONAL_AUTHORISATION_PENDING', 'ADDITIONAL_AUTHORISATION_CONFIRMED',
      'CAPTURE_LIMIT_EXCEEDED', 'PARTIAL_CAPTURE_ONLY', 'CAPTURE_CONFIRMED'
    ])
    OR upper(coalesce(p_provider_state, '')) IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED', 'CAPTURED');
$$;

CREATE OR REPLACE FUNCTION public.tr_payment_session_ledger_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_new_auth boolean;
  v_old_auth boolean := false;
  v_trip_linked boolean;
  v_failed boolean;
BEGIN
  IF NEW.purpose::text IS DISTINCT FROM 'RIDE_BOOKING'
     OR NEW.provider_order_id IS NULL
     OR btrim(NEW.provider_order_id) = '' THEN
    RETURN NULL;
  END IF;

  v_new_auth := public.payment_session_has_authorisation_evidence(
    NEW.status::text, NEW.authorised_at, NEW.provider_state);

  IF TG_OP = 'UPDATE' THEN
    v_old_auth := public.payment_session_has_authorisation_evidence(
      OLD.status::text, OLD.authorised_at, OLD.provider_state);
    v_trip_linked := OLD.trip_id IS NULL AND NEW.trip_id IS NOT NULL;
    v_failed := NOT v_new_auth
      AND NEW.status::text IN ('failed', 'cancelled')
      AND OLD.status IS DISTINCT FROM NEW.status;
  ELSE
    v_trip_linked := NEW.trip_id IS NOT NULL;
    v_failed := NOT v_new_auth AND NEW.status::text IN ('failed', 'cancelled');
  END IF;

  IF NOT ((v_new_auth AND NOT v_old_auth) OR v_trip_linked OR v_failed) THEN
    RETURN NULL;
  END IF;

  -- Adopt a row written for this booking by a writer that cannot set the session
  -- column (same idempotency key, no owner session yet).
  UPDATE public.payment_authorization_ledger l
     SET payment_session_id = NEW.id,
         provider_order_id = COALESCE(l.provider_order_id, NEW.provider_order_id),
         updated_at = now()
   WHERE l.operation = 'initial_auth'
     AND l.payment_session_id IS NULL
     AND l.idempotency_key = NEW.idempotency_key
     AND NOT EXISTS (
       SELECT 1 FROM public.payment_authorization_ledger x
        WHERE x.payment_session_id = NEW.id AND x.operation = 'initial_auth'
     );

  -- Backstop: create-preauth normally writes the pending row before Pay. When that
  -- write is missing, record it here and tag it so the gap stays visible.
  INSERT INTO public.payment_authorization_ledger (
    trip_id, payment_session_id, provider_order_id, fare_revision_number, operation,
    idempotency_key, amount_pence, status, metadata
  ) VALUES (
    NEW.trip_id, NEW.id, NEW.provider_order_id, 0, 'initial_auth',
    NEW.idempotency_key, GREATEST(COALESCE(NEW.authorised_amount_pence, 0), 0), 'pending',
    jsonb_build_object(
      'provider', NEW.payment_provider,
      'provider_order_id', NEW.provider_order_id,
      'client_action_id', NEW.client_action_id,
      'payment_session_id', NEW.id,
      'created_by', 'payment_sessions_trigger_backstop'
    )
  )
  ON CONFLICT DO NOTHING;

  IF v_new_auth AND NOT v_old_auth THEN
    UPDATE public.payment_authorization_ledger l
       SET status = 'succeeded',
           amount_pence = GREATEST(COALESCE(NEW.authorised_amount_pence, l.amount_pence), 0),
           error_message = NULL,
           metadata = l.metadata || jsonb_build_object(
             'authorised_recorded_at', now(),
             'authorised_session_status', NEW.status::text,
             'authorised_provider_state', NEW.provider_state
           ),
           updated_at = now()
     WHERE l.payment_session_id = NEW.id
       AND l.operation = 'initial_auth'
       AND l.status IN ('pending', 'failed');
  END IF;

  IF v_failed THEN
    UPDATE public.payment_authorization_ledger l
       SET status = 'failed',
           error_message = left(
             'session_' || NEW.status::text || COALESCE(': ' || NEW.failure_reason, ''), 200),
           metadata = l.metadata || jsonb_build_object(
             'failed_recorded_at', now(),
             'failed_session_status', NEW.status::text
           ),
           updated_at = now()
     WHERE l.payment_session_id = NEW.id
       AND l.operation = 'initial_auth'
       AND l.status = 'pending';
  END IF;

  IF NEW.trip_id IS NOT NULL THEN
    UPDATE public.payment_authorization_ledger l
       SET trip_id = NEW.trip_id,
           updated_at = now()
     WHERE l.payment_session_id = NEW.id
       AND l.operation = 'initial_auth'
       AND l.trip_id IS NULL;
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.payment_session_has_authorisation_evidence(text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_payment_session_ledger_sync() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.payment_session_has_authorisation_evidence(text, timestamptz, text) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION public.tr_payment_session_ledger_sync() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.payment_session_has_authorisation_evidence(text, timestamptz, text) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION public.tr_payment_session_ledger_sync() FROM authenticated';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_payment_session_ledger_sync ON public.payment_sessions;
CREATE TRIGGER trg_payment_session_ledger_sync
  AFTER INSERT OR UPDATE OF status, authorised_at, provider_state, trip_id
  ON public.payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_payment_session_ledger_sync();
