-- Phase 1 scheduled finance (IN-REPO ONLY — do not apply to production until release approval).
-- 1) Persist Revolut capture_deadline on payment_sessions
-- 2) Set max_advance_days = 5 (120 elapsed hours UTC via application SSOT)
-- 3) Extend assert_payment_gate with scheduled capture-coverage when deadline is known
-- 4) Backend advance-window helper for booking paths / triggers
-- 5) payment_gate_blocked terminal hygiene helper

BEGIN;

-- ── 1) payment_sessions capture deadline columns (backward compatible) ────────
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_deadline timestamptz NULL,
  ADD COLUMN IF NOT EXISTS capture_deadline_source text NULL,
  ADD COLUMN IF NOT EXISTS capture_deadline_updated_at timestamptz NULL;

COMMENT ON COLUMN public.payment_sessions.capture_deadline IS
  'Authoritative Revolut capture_deadline for the bound authorisation. Never invent a universal TTL.';
COMMENT ON COLUMN public.payment_sessions.capture_deadline_source IS
  'provider_create | provider_retrieve | provider_webhook | provider_increment | backfill';

CREATE INDEX IF NOT EXISTS idx_payment_sessions_capture_deadline
  ON public.payment_sessions (capture_deadline)
  WHERE capture_deadline IS NOT NULL
    AND released_at IS NULL
    AND captured_at IS NULL;

-- Never overwrite a valid deadline with NULL from a sparse provider patch.
CREATE OR REPLACE FUNCTION public.payment_sessions_preserve_capture_deadline()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.capture_deadline IS NULL AND OLD.capture_deadline IS NOT NULL THEN
    NEW.capture_deadline := OLD.capture_deadline;
    NEW.capture_deadline_source := COALESCE(NEW.capture_deadline_source, OLD.capture_deadline_source);
    NEW.capture_deadline_updated_at := COALESCE(NEW.capture_deadline_updated_at, OLD.capture_deadline_updated_at);
  ELSIF NEW.capture_deadline IS DISTINCT FROM OLD.capture_deadline
        AND NEW.capture_deadline IS NOT NULL THEN
    NEW.capture_deadline_updated_at := COALESCE(NEW.capture_deadline_updated_at, now());
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_payment_sessions_preserve_capture_deadline ON public.payment_sessions;
CREATE TRIGGER trg_payment_sessions_preserve_capture_deadline
  BEFORE UPDATE ON public.payment_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_sessions_preserve_capture_deadline();

-- ── 2) max_advance_days = 5 (Phase 1 product decision) ───────────────────────
ALTER TABLE public.global_dispatch_settings
  ALTER COLUMN max_advance_days SET DEFAULT 5;

UPDATE public.global_dispatch_settings
   SET max_advance_days = 5,
       updated_at = now()
 WHERE singleton = true
   AND COALESCE(max_advance_days, 30) <> 5;

-- Optional rollout latch (default false until backfill + dry-run complete).
ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS scheduled_capture_coverage_enforced boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.global_dispatch_settings.scheduled_capture_coverage_enforced IS
  'Legacy-session latch only: when true, assert_payment_gate fails closed if capture_deadline is missing on grandfathered sessions. New create-path sessions stamp metadata.scheduled_capture_coverage_required=true and always require a deadline regardless of this flag. Keep false until backfill completes.';

-- ── 3) UTC elapsed advance window (shared authoritative policy) ──────────────
CREATE OR REPLACE FUNCTION public.evaluate_scheduled_advance_window(
  p_scheduled_at timestamptz,
  p_now timestamptz DEFAULT now(),
  p_min_advance_minutes integer DEFAULT NULL,
  p_max_advance_days integer DEFAULT NULL,
  p_grandfather_max_advance boolean DEFAULT false
)
RETURNS TABLE (
  ok boolean,
  code text,
  reason text,
  min_advance_minutes integer,
  max_advance_days integer
)
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_min integer;
  v_max integer;
  v_enabled boolean;
  v_max_ms bigint;
BEGIN
  SELECT
    COALESCE(p_min_advance_minutes, g.min_advance_time_minutes, 20),
    COALESCE(p_max_advance_days, g.max_advance_days, 5),
    COALESCE(g.scheduled_rides_enabled, true)
  INTO v_min, v_max, v_enabled
  FROM public.global_dispatch_settings g
  WHERE g.singleton = true;

  IF NOT FOUND THEN
    v_min := COALESCE(p_min_advance_minutes, 20);
    v_max := COALESCE(p_max_advance_days, 5);
    v_enabled := true;
  END IF;

  IF NOT v_enabled THEN
    RETURN QUERY SELECT false, 'DISABLED'::text, 'Scheduled rides are not available.'::text, v_min, v_max;
    RETURN;
  END IF;

  IF p_scheduled_at IS NULL THEN
    RETURN QUERY SELECT false, 'INVALID_SCHEDULED_AT'::text, 'Pickup time is invalid.'::text, v_min, v_max;
    RETURN;
  END IF;

  IF p_scheduled_at < (p_now + make_interval(mins => GREATEST(v_min, 0))) THEN
    RETURN QUERY SELECT false, 'TOO_SOON'::text,
      format('Pickup must be at least %s minutes from now.', v_min)::text, v_min, v_max;
    RETURN;
  END IF;

  IF NOT COALESCE(p_grandfather_max_advance, false) THEN
    -- Exactly max_advance_days × 24 elapsed hours (UTC). DST cannot extend the window.
    v_max_ms := (v_max::bigint) * 24 * 60 * 60 * 1000;
    IF (EXTRACT(EPOCH FROM (p_scheduled_at - p_now)) * 1000) > v_max_ms THEN
      RETURN QUERY SELECT false, 'TOO_FAR'::text,
        format('Pickup cannot be more than %s hours (%s days) from now.', v_max * 24, v_max)::text,
        v_min, v_max;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT true, 'OK'::text, 'within_window'::text, v_min, v_max;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.assert_scheduled_advance_window(
  p_scheduled_at timestamptz,
  p_now timestamptz DEFAULT now(),
  p_grandfather_max_advance boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_row RECORD;
BEGIN
  SELECT * INTO v_row
  FROM public.evaluate_scheduled_advance_window(
    p_scheduled_at, p_now, NULL, NULL, p_grandfather_max_advance
  );
  IF NOT v_row.ok THEN
    RAISE EXCEPTION 'SCHEDULED_ADVANCE_WINDOW: % — %', v_row.code, v_row.reason
      USING ERRCODE = 'P0001';
  END IF;
END;
$fn$;

-- Required coverage horizon: pickup + duration + 360 minutes.
CREATE OR REPLACE FUNCTION public.required_capture_coverage_until(
  p_scheduled_at timestamptz,
  p_estimated_duration_minutes integer DEFAULT 30,
  p_safety_margin_minutes integer DEFAULT 360
)
RETURNS timestamptz
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN p_scheduled_at IS NULL THEN NULL
    ELSE p_scheduled_at
      + make_interval(mins => GREATEST(COALESCE(NULLIF(p_estimated_duration_minutes, 0), 30), 1))
      + make_interval(mins => GREATEST(COALESCE(p_safety_margin_minutes, 360), 0))
  END;
$fn$;

-- ── 4) assert_payment_gate — amount gate + scheduled capture coverage ────────
CREATE OR REPLACE FUNCTION public.assert_payment_gate(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
  v_required_until timestamptz;
  v_enforced boolean := false;
  v_is_scheduled boolean := false;
BEGIN
  SELECT id, payment_method, payment_session_id, currency_code, financial_model,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence, is_scheduled, scheduled_at, estimated_duration_minutes,
         status, started_at
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001';
  END IF;

  -- Never cancel / fail mid-journey coverage from this gate — in-progress uses recovery_required.
  IF v_trip.started_at IS NOT NULL
     OR UPPER(COALESCE(v_trip.status, '')) IN (
       'IN_PROGRESS', 'IN_TRIP', 'STARTED', 'ARRIVED', 'WAITING', 'ON_TRIP'
     ) THEN
    -- Still require amount gate for PLATFORM_COLLECTED card, but skip capture-horizon cancel semantics.
    NULL;
  END IF;

  IF v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN;
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN;
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % has no payment_session_id', p_trip_id
      USING ERRCODE='P0001';
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at, trip_id, metadata,
         capture_deadline
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session missing' USING ERRCODE='P0001';
  END IF;

  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id <> p_trip_id THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session bound to different trip'
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'payment_orphaned','orphan_authorisation'
  ) OR COALESCE(v_ps.metadata->>'never_capture','') = 'true' THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session orphaned/superseded'
      USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','released',
    'RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold released without capture'
      USING ERRCODE='P0001';
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_authorised
      USING ERRCODE='P0001';
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: locked customer payable missing'
      USING ERRCODE='P0001';
  END IF;

  IF v_authorised < v_required THEN
    RAISE EXCEPTION
      'PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=% required=%',
      v_authorised, v_required
      USING ERRCODE='P0001';
  END IF;

  -- Scheduled capture-deadline coverage (pre-start only).
  v_is_scheduled := COALESCE(v_trip.is_scheduled, false) OR v_trip.scheduled_at IS NOT NULL;
  IF v_is_scheduled
     AND v_trip.started_at IS NULL
     AND UPPER(COALESCE(v_trip.status, '')) NOT IN (
       'IN_PROGRESS', 'IN_TRIP', 'STARTED', 'ARRIVED', 'WAITING', 'ON_TRIP',
       'COMPLETED', 'CANCELLED', 'CANCELED', 'NO_SHOW', 'EXPIRED'
     )
  THEN
    SELECT COALESCE(scheduled_capture_coverage_enforced, false)
      INTO v_enforced
      FROM public.global_dispatch_settings
     WHERE singleton = true;

    v_required_until := public.required_capture_coverage_until(
      v_trip.scheduled_at,
      v_trip.estimated_duration_minutes,
      360
    );

    IF v_ps.capture_deadline IS NOT NULL AND v_required_until IS NOT NULL THEN
      IF v_ps.capture_deadline < v_required_until THEN
        RAISE EXCEPTION
          'PAYMENT_GATE_NOT_SATISFIED: CAPTURE_DEADLINE_INSUFFICIENT deadline=% required_until=%',
          v_ps.capture_deadline, v_required_until
          USING ERRCODE='P0001';
      END IF;
    ELSIF v_enforced AND v_ps.capture_deadline IS NULL THEN
      RAISE EXCEPTION
        'PAYMENT_GATE_NOT_SATISFIED: CAPTURE_DEADLINE_MISSING'
        USING ERRCODE='P0001';
    END IF;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.assert_payment_gate(uuid) IS
  'Dispatch/accept gate: PLATFORM_COLLECTED card trips require usable hold with authorised >= locked customer payable, and scheduled trips require capture_deadline coverage when known (or enforced).';

-- ── 5) payment_gate_blocked terminal hygiene (no refunds/releases/notifications) ─
-- Normalise historical rows that are already terminal but still tagged payment_gate_blocked.
CREATE OR REPLACE FUNCTION public.normalise_payment_gate_blocked_terminal_rows(
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (
  trip_id uuid,
  old_scheduled_status text,
  new_scheduled_status text,
  trip_status text,
  action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT t.id, t.scheduled_status::text AS old_ss, t.status::text AS trip_status
      FROM public.trips t
     WHERE t.scheduled_status::text = 'payment_gate_blocked'
       AND (
         t.completed_at IS NOT NULL
         OR t.cancelled_at IS NOT NULL
         OR UPPER(COALESCE(t.status, '')) IN (
           'COMPLETED', 'CANCELLED', 'CANCELED', 'NO_SHOW', 'EXPIRED'
         )
       )
  ),
  updated AS (
    UPDATE public.trips t
       SET scheduled_status = CASE
             WHEN UPPER(c.trip_status) IN ('COMPLETED') THEN 'completed'
             ELSE 'cancelled'
           END,
           updated_at = now()
      FROM candidates c
     WHERE t.id = c.id
       AND p_dry_run = false
    RETURNING t.id, c.old_ss, t.scheduled_status::text, c.trip_status, 'normalised'::text
  )
  SELECT c.id, c.old_ss,
         CASE WHEN UPPER(c.trip_status) IN ('COMPLETED') THEN 'completed' ELSE 'cancelled' END,
         c.trip_status,
         CASE WHEN p_dry_run THEN 'dry_run' ELSE 'normalised' END
    FROM candidates c
   WHERE p_dry_run = true
  UNION ALL
  SELECT * FROM updated
  WHERE p_dry_run = false;
END;
$fn$;

REVOKE ALL ON FUNCTION public.normalise_payment_gate_blocked_terminal_rows(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalise_payment_gate_blocked_terminal_rows(boolean) TO service_role;

-- Dry-run classification helper for non-terminal scheduled sessions missing deadlines.
CREATE OR REPLACE FUNCTION public.classify_scheduled_capture_deadline_backfill(
  p_dry_run boolean DEFAULT true
)
RETURNS TABLE (
  payment_session_id uuid,
  trip_id uuid,
  provider_order_id text,
  scheduled_at timestamptz,
  capture_deadline timestamptz,
  classification text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT
    ps.id,
    t.id,
    ps.provider_order_id,
    t.scheduled_at,
    ps.capture_deadline,
    CASE
      WHEN ps.released_at IS NOT NULL AND ps.captured_at IS NULL THEN 'released_hold'
      WHEN UPPER(COALESCE(ps.provider_state, '')) NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED')
        THEN 'provider_state_not_authorised'
      WHEN ps.capture_deadline IS NULL THEN 'deadline_missing_needs_retrieve'
      WHEN ps.capture_deadline < public.required_capture_coverage_until(
             t.scheduled_at, t.estimated_duration_minutes, 360
           )
        THEN 'deadline_insufficient'
      ELSE 'covered'
    END AS classification
  FROM public.trips t
  JOIN public.payment_sessions ps ON ps.id = t.payment_session_id
  WHERE COALESCE(t.is_scheduled, false) = true
    AND t.scheduled_at IS NOT NULL
    AND t.scheduled_at > now()
    AND t.completed_at IS NULL
    AND t.cancelled_at IS NULL
    AND UPPER(COALESCE(t.status, '')) NOT IN (
      'COMPLETED', 'CANCELLED', 'CANCELED', 'NO_SHOW', 'EXPIRED'
    )
    AND UPPER(COALESCE(t.payment_method, '')) IN ('CARD', 'APPLE_PAY', 'GOOGLE_PAY')
    AND (p_dry_run OR true);
$fn$;

REVOKE ALL ON FUNCTION public.classify_scheduled_capture_deadline_backfill(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classify_scheduled_capture_deadline_backfill(boolean) TO service_role;

COMMIT;
