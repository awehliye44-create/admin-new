-- MK-260922-001 / PR #66: atomic tip-window trigger mutex + distinct EXPIRED status.
-- Exactly one trigger may own finalisation. Preserve existing CLOSED rows.
-- Rollback: rollback/rollback_20261126120000_tip_window_trigger_mutex.sql

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS tip_window_trigger text,
  ADD COLUMN IF NOT EXISTS tip_window_claim_token uuid,
  ADD COLUMN IF NOT EXISTS tip_window_claimed_at timestamptz;

COMMENT ON COLUMN public.trips.tip_window_trigger IS
  'Winning tip-window capture trigger: CUSTOMER_SKIP | CUSTOMER_SUBMIT_NO_TIP | CUSTOMER_SUBMIT_WITH_TIP | WINDOW_EXPIRED';
COMMENT ON COLUMN public.trips.tip_window_claim_token IS
  'Opaque claim token while tip_window_status=processing; released on tip-auth decline, sealed on finalize.';
COMMENT ON COLUMN public.trips.tip_window_claimed_at IS
  'When the tip-window trigger mutex was claimed (processing).';

-- Drop legacy open|closed-only check if present; replace with expanded set.
DO $$
DECLARE
  cname text;
BEGIN
  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'trips'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%tip_window_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.trips DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_tip_window_status_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_tip_window_status_check
  CHECK (
    tip_window_status IS NULL
    OR tip_window_status IN ('open', 'processing', 'closed', 'expired')
  );

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_tip_window_trigger_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_tip_window_trigger_check
  CHECK (
    tip_window_trigger IS NULL
    OR tip_window_trigger IN (
      'CUSTOMER_SKIP',
      'CUSTOMER_SUBMIT_NO_TIP',
      'CUSTOMER_SUBMIT_WITH_TIP',
      'WINDOW_EXPIRED'
    )
  );

CREATE OR REPLACE FUNCTION public.claim_tip_window_trigger(
  p_trip_id uuid,
  p_trigger text,
  p_claim_token uuid,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.trips%ROWTYPE;
  v_status text;
BEGIN
  IF p_trip_id IS NULL OR p_trigger IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS');
  END IF;

  IF p_trigger NOT IN (
    'CUSTOMER_SKIP',
    'CUSTOMER_SUBMIT_NO_TIP',
    'CUSTOMER_SUBMIT_WITH_TIP',
    'WINDOW_EXPIRED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIGGER');
  END IF;

  SELECT * INTO v_row
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  v_status := lower(coalesce(v_row.tip_window_status, 'open'));

  -- Terminal: another trigger already won.
  IF v_row.tip_window_closed_at IS NOT NULL
     OR v_status IN ('closed', 'expired') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'ALREADY_CLOSED',
      'tip_window_status', v_row.tip_window_status,
      'tip_window_trigger', v_row.tip_window_trigger,
      'tip_window_closed_at', v_row.tip_window_closed_at
    );
  END IF;

  -- Same claim token re-entering (duplicate submit / reconcile) — keep ownership.
  IF v_status = 'processing'
     AND v_row.tip_window_claim_token IS NOT NULL
     AND v_row.tip_window_claim_token = p_claim_token THEN
    RETURN jsonb_build_object(
      'ok', true,
      'claimed', true,
      'idempotent', true,
      'tip_window_status', 'processing',
      'tip_window_trigger', v_row.tip_window_trigger,
      'claim_token', v_row.tip_window_claim_token
    );
  END IF;

  -- Another owner holds the mutex (including in-flight / provider UNKNOWN reconcile).
  -- Bounded stale recovery: WINDOW_EXPIRED may reclaim only after the claim is
  -- older than 5 minutes AND the tip window has already expired. This never
  -- captures; it only transfers the mutex so fare-only expiry can proceed.
  -- Customer triggers never steal a live claim.
  -- PROVIDER_UNKNOWN_RECONCILE_ONLY: non-stale CLAIM_HELD retains ownership.
  IF v_status = 'processing'
     AND v_row.tip_window_claim_token IS NOT NULL
     AND v_row.tip_window_claim_token <> p_claim_token THEN
    IF p_trigger = 'WINDOW_EXPIRED'
       AND v_row.tip_window_claimed_at IS NOT NULL
       AND v_row.tip_window_claimed_at <= (p_now - interval '5 minutes')
       AND v_row.tip_window_expires_at IS NOT NULL
       AND v_row.tip_window_expires_at <= p_now
    THEN
      NULL; -- fall through to reclaim UPDATE below
    ELSE
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'CLAIM_HELD',
        'tip_window_status', 'processing',
        'tip_window_trigger', v_row.tip_window_trigger,
        'tip_window_claimed_at', v_row.tip_window_claimed_at
      );
    END IF;
  END IF;

  IF p_trigger = 'WINDOW_EXPIRED' THEN
    IF v_row.tip_window_expires_at IS NULL OR v_row.tip_window_expires_at > p_now THEN
      RETURN jsonb_build_object('ok', false, 'code', 'WINDOW_STILL_OPEN');
    END IF;
  ELSE
    IF v_row.tip_window_expires_at IS NULL OR v_row.tip_window_expires_at <= p_now THEN
      RETURN jsonb_build_object('ok', false, 'code', 'WINDOW_NOT_OPEN');
    END IF;
  END IF;

  UPDATE public.trips
  SET
    tip_window_status = 'processing',
    tip_window_trigger = p_trigger,
    tip_window_claim_token = p_claim_token,
    tip_window_claimed_at = p_now,
    updated_at = p_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed', true,
    'idempotent', false,
    'tip_window_status', 'processing',
    'tip_window_trigger', p_trigger,
    'claim_token', p_claim_token
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_tip_window_trigger_claim(
  p_trip_id uuid,
  p_claim_token uuid,
  p_clear_tip boolean DEFAULT true,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.trips%ROWTYPE;
BEGIN
  IF p_trip_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS');
  END IF;

  SELECT * INTO v_row
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Already terminal — do not reopen.
  IF v_row.tip_window_closed_at IS NOT NULL
     OR lower(coalesce(v_row.tip_window_status, '')) IN ('closed', 'expired') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'released', false,
      'code', 'ALREADY_CLOSED',
      'tip_window_status', v_row.tip_window_status,
      'tip_window_trigger', v_row.tip_window_trigger
    );
  END IF;

  IF v_row.tip_window_claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOKEN_MISMATCH');
  END IF;

  UPDATE public.trips
  SET
    tip_window_status = 'open',
    tip_window_trigger = NULL,
    tip_window_claim_token = NULL,
    tip_window_claimed_at = NULL,
    tip_amount_pence = CASE WHEN p_clear_tip THEN 0 ELSE tip_amount_pence END,
    tip_pence = CASE WHEN p_clear_tip THEN 0 ELSE tip_pence END,
    updated_at = p_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'released', true,
    'tip_window_status', 'open'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_tip_window_trigger(
  p_trip_id uuid,
  p_claim_token uuid,
  p_terminal_status text,
  p_tip_pence integer DEFAULT 0,
  p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.trips%ROWTYPE;
  v_tip integer;
BEGIN
  IF p_trip_id IS NULL OR p_claim_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS');
  END IF;

  IF p_terminal_status NOT IN ('closed', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TERMINAL_STATUS');
  END IF;

  v_tip := GREATEST(0, COALESCE(p_tip_pence, 0));

  SELECT * INTO v_row
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Idempotent: already sealed — never mutate terminal status/trigger/tip.
  IF v_row.tip_window_closed_at IS NOT NULL
     OR lower(coalesce(v_row.tip_window_status, '')) IN ('closed', 'expired') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'finalized', true,
      'idempotent', true,
      'immutable', true,
      'tip_window_status', v_row.tip_window_status,
      'tip_window_trigger', v_row.tip_window_trigger,
      'tip_amount_pence', COALESCE(v_row.tip_amount_pence, 0)
    );
  END IF;

  IF v_row.tip_window_claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TOKEN_MISMATCH');
  END IF;

  UPDATE public.trips
  SET
    tip_amount_pence = v_tip,
    tip_pence = v_tip,
    tip_window_closed_at = p_now,
    tip_window_status = p_terminal_status,
    tip_window_claim_token = NULL,
    tip_window_claimed_at = NULL,
    -- Keep tip_window_trigger as the winning owner.
    updated_at = p_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'ok', true,
    'finalized', true,
    'idempotent', false,
    'tip_window_status', p_terminal_status,
    'tip_window_trigger', v_row.tip_window_trigger,
    'tip_amount_pence', v_tip
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_tip_window_trigger(uuid, text, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_tip_window_trigger(uuid, text, uuid, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tip_window_trigger(uuid, text, uuid, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.release_tip_window_trigger_claim(uuid, uuid, boolean, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_tip_window_trigger_claim(uuid, uuid, boolean, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tip_window_trigger_claim(uuid, uuid, boolean, timestamptz) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_tip_window_trigger(uuid, uuid, text, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_tip_window_trigger(uuid, uuid, text, integer, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_tip_window_trigger(uuid, uuid, text, integer, timestamptz) TO service_role;

COMMENT ON FUNCTION public.claim_tip_window_trigger IS
  'Atomic tip-window trigger mutex: OPEN→PROCESSING for exactly one of A/B/C/D.';
COMMENT ON FUNCTION public.release_tip_window_trigger_claim IS
  'Release tip-window claim after tip-auth decline; restores OPEN; no capture.';
COMMENT ON FUNCTION public.finalize_tip_window_trigger IS
  'Seal tip window as CLOSED or EXPIRED after provider-confirmed capture.';
