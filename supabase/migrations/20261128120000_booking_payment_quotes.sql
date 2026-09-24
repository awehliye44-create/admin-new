-- ============================================================
-- Opaque booking-payment quotes (payment admission SSOT)
--
-- Server issues a persisted quote; create-preauth consumes it
-- atomically. Client never constructs or edits the quote token.
-- Replaces client-built outstanding:<pence>:v1 as admission authority.
--
-- Forward-only. Do NOT apply unless explicitly approved.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.booking_payment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  user_id uuid NOT NULL,
  client_action_id uuid NOT NULL,
  service_area_id uuid NULL,
  ride_category text NOT NULL DEFAULT '',
  route_fingerprint text NOT NULL,
  currency text NOT NULL DEFAULT 'gbp',
  trip_fare_pence integer NOT NULL,
  buffer_pence integer NOT NULL DEFAULT 0,
  receivable_pence integer NOT NULL,
  total_authorisation_pence integer NOT NULL,
  fold_eligible boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'ISSUED',
  consumed_payment_session_id uuid NULL REFERENCES public.payment_sessions(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_payment_quotes_state_chk CHECK (
    state IN ('ISSUED', 'CONSUMED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT booking_payment_quotes_trip_fare_nonneg_chk CHECK (trip_fare_pence >= 0),
  CONSTRAINT booking_payment_quotes_buffer_nonneg_chk CHECK (buffer_pence >= 0),
  CONSTRAINT booking_payment_quotes_receivable_nonneg_chk CHECK (receivable_pence >= 0),
  CONSTRAINT booking_payment_quotes_total_nonneg_chk CHECK (total_authorisation_pence >= 0),
  CONSTRAINT booking_payment_quotes_total_matches_chk CHECK (
    total_authorisation_pence = trip_fare_pence + buffer_pence
      + CASE WHEN fold_eligible THEN receivable_pence ELSE 0 END
  ),
  CONSTRAINT booking_payment_quotes_consumed_session_chk CHECK (
    (state = 'CONSUMED' AND consumed_payment_session_id IS NOT NULL)
    OR (state <> 'CONSUMED' AND consumed_payment_session_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_quotes_client_action_issued_uidx
  ON public.booking_payment_quotes (client_action_id)
  WHERE state = 'ISSUED';

CREATE INDEX IF NOT EXISTS booking_payment_quotes_customer_state_idx
  ON public.booking_payment_quotes (customer_id, state, expires_at);

CREATE INDEX IF NOT EXISTS booking_payment_quotes_expires_idx
  ON public.booking_payment_quotes (expires_at)
  WHERE state = 'ISSUED';

-- One payment session may consume at most one quote.
CREATE UNIQUE INDEX IF NOT EXISTS booking_payment_quotes_consumed_session_uidx
  ON public.booking_payment_quotes (consumed_payment_session_id)
  WHERE consumed_payment_session_id IS NOT NULL;

ALTER TABLE public.booking_payment_quotes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.booking_payment_quotes FROM PUBLIC;
REVOKE ALL ON TABLE public.booking_payment_quotes FROM anon, authenticated;
GRANT ALL ON TABLE public.booking_payment_quotes TO service_role;

-- Financial fields immutable after issuance (state/consume/expiry only).
CREATE OR REPLACE FUNCTION public.booking_payment_quotes_immutable_financials()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public
AS $trg$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.client_action_id IS DISTINCT FROM OLD.client_action_id
       OR NEW.service_area_id IS DISTINCT FROM OLD.service_area_id
       OR NEW.ride_category IS DISTINCT FROM OLD.ride_category
       OR NEW.route_fingerprint IS DISTINCT FROM OLD.route_fingerprint
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.trip_fare_pence IS DISTINCT FROM OLD.trip_fare_pence
       OR NEW.buffer_pence IS DISTINCT FROM OLD.buffer_pence
       OR NEW.receivable_pence IS DISTINCT FROM OLD.receivable_pence
       OR NEW.total_authorisation_pence IS DISTINCT FROM OLD.total_authorisation_pence
       OR NEW.fold_eligible IS DISTINCT FROM OLD.fold_eligible
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    THEN
      RAISE EXCEPTION 'booking_payment_quotes financial fields are immutable after issuance'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$trg$;

DROP TRIGGER IF EXISTS booking_payment_quotes_immutable_financials_trg
  ON public.booking_payment_quotes;
CREATE TRIGGER booking_payment_quotes_immutable_financials_trg
  BEFORE UPDATE ON public.booking_payment_quotes
  FOR EACH ROW
  EXECUTE FUNCTION public.booking_payment_quotes_immutable_financials();

-- ─── RPC: consume quote (one consumer, FOR UPDATE) ────────────

CREATE OR REPLACE FUNCTION public.consume_booking_payment_quote(
  p_quote_id uuid,
  p_customer_id uuid,
  p_client_action_id uuid,
  p_payment_session_id uuid,
  p_expected_receivable_pence integer,
  p_gate_enabled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_quote public.booking_payment_quotes%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_quote_id IS NULL OR p_customer_id IS NULL
     OR p_client_action_id IS NULL OR p_payment_session_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'missing_required_args'
    );
  END IF;

  SELECT * INTO v_quote
  FROM public.booking_payment_quotes
  WHERE id = p_quote_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'quote_not_found'
    );
  END IF;

  IF v_quote.customer_id IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'customer_mismatch'
    );
  END IF;

  -- Session must belong to the same customer + client_action (no cross-claim).
  IF NOT EXISTS (
    SELECT 1
    FROM public.payment_sessions ps
    WHERE ps.id = p_payment_session_id
      AND ps.customer_id IS NOT DISTINCT FROM p_customer_id
      AND ps.client_action_id IS NOT DISTINCT FROM p_client_action_id::text
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'payment_session_customer_or_ca_mismatch'
    );
  END IF;

  -- Idempotent same CA + already consumed
  IF v_quote.state = 'CONSUMED' THEN
    IF v_quote.client_action_id = p_client_action_id
       AND v_quote.consumed_payment_session_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'quote_id', v_quote.id,
        'payment_session_id', v_quote.consumed_payment_session_id,
        'total_authorisation_pence', v_quote.total_authorisation_pence,
        'trip_fare_pence', v_quote.trip_fare_pence,
        'receivable_pence', v_quote.receivable_pence,
        'fold_eligible', v_quote.fold_eligible
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'quote_consumed_different_client_action'
    );
  END IF;

  IF v_quote.state IN ('EXPIRED', 'CANCELLED')
     OR v_quote.expires_at <= now() THEN
    IF v_quote.state = 'ISSUED' AND v_quote.expires_at <= now() THEN
      UPDATE public.booking_payment_quotes
      SET state = 'EXPIRED', updated_at = now()
      WHERE id = v_quote.id AND state = 'ISSUED';
    END IF;
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'FARE_QUOTE_EXPIRED',
      'note', 'quote_expired'
    );
  END IF;

  IF v_quote.state IS DISTINCT FROM 'ISSUED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'quote_not_issued'
    );
  END IF;

  IF v_quote.client_action_id IS DISTINCT FROM p_client_action_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'client_action_mismatch'
    );
  END IF;

  -- Emergency gate OFF rejects unconsumed fold-eligible quotes
  IF v_quote.fold_eligible IS TRUE AND coalesce(p_gate_enabled, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'RECEIVABLE_FOLD_UNAVAILABLE',
      'note', 'gate_off_rejects_unconsumed_fold_quote'
    );
  END IF;

  IF coalesce(p_expected_receivable_pence, -1) IS DISTINCT FROM v_quote.receivable_pence THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'OUTSTANDING_BALANCE_CHANGED',
      'note', 'open_receivable_mismatch',
      'quoted_receivable_pence', v_quote.receivable_pence,
      'expected_receivable_pence', p_expected_receivable_pence
    );
  END IF;

  UPDATE public.booking_payment_quotes
  SET
    state = 'CONSUMED',
    consumed_payment_session_id = p_payment_session_id,
    updated_at = now()
  WHERE id = v_quote.id
    AND state = 'ISSUED';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'BOOKING_QUOTE_INVALID',
      'note', 'concurrent_consume_lost'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'quote_id', v_quote.id,
    'payment_session_id', p_payment_session_id,
    'total_authorisation_pence', v_quote.total_authorisation_pence,
    'trip_fare_pence', v_quote.trip_fare_pence,
    'receivable_pence', v_quote.receivable_pence,
    'fold_eligible', v_quote.fold_eligible
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.consume_booking_payment_quote(
  uuid, uuid, uuid, uuid, integer, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_booking_payment_quote(
  uuid, uuid, uuid, uuid, integer, boolean
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_booking_payment_quote(
  uuid, uuid, uuid, uuid, integer, boolean
) TO service_role;

COMMIT;
