-- ============================================================
-- Admin assignment atomicity (Gap closure follow-up)
-- Branch: fix/scheduled-booking-gap-closure-final
-- NOT APPLIED to production — explicit approval required.
--
-- assign_now in admin_scheduled_emergency_mutate previously mutated
-- confirmed_driver_id after Edge-only prechecks (no per-driver advisory
-- lock, no SQL commitment gate, no SQL wallet gate). That raced with
-- marketplace accept_scheduled_ride.
--
-- Deferred assign_at only stamped pending_release_*; scheduled-dispatch
-- then did a direct trips UPDATE with payment gate only.
--
-- Fix (same shared gate + lock as accept_scheduled_ride — no parallel engine):
--   1) Patch assign_now inside admin_scheduled_emergency_mutate
--   2) Add execute_due_pending_scheduled_assign for cron execution-time
--      revalidation (payment + commitment + wallet) under the same lock
-- ============================================================

-- ── 1) Patch admin_scheduled_emergency_mutate assign_now ─────────────────────
DO $patch$
DECLARE
  v_def text;
  v_marker text :=
$m$
    BEGIN
      PERFORM public.assert_payment_gate(p_trip_id);
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_GATE_NOT_SATISFIED',
        'message', SQLERRM
      );
    END;
    UPDATE public.trips SET
      confirmed_driver_id = v_driver,
      scheduled_status = 'driver_assigned',
$m$;
  v_inject text :=
$inj$
    BEGIN
      PERFORM public.assert_payment_gate(p_trip_id);
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_GATE_NOT_SATISFIED',
        'message', SQLERRM
      );
    END;

    -- Serialize with marketplace accept_scheduled_ride / accept_ride_offer.
    PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver::text));

    IF COALESCE(
         (public.driver_scheduled_commitment_gate(v_driver, p_trip_id, 'additional_scheduled') ->> 'allowed')::boolean,
         true
       ) = false
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'SCHEDULED_COMMITMENT_INFEASIBLE',
        'message', 'This driver already has a confirmed scheduled booking that makes this assignment infeasible.',
        'commitment_trip_id',
          public.driver_scheduled_commitment_gate(v_driver, p_trip_id, 'additional_scheduled') ->> 'commitment_trip_id'
      );
    END IF;

    IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_driver, p_trip_id) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
        'message', 'Driver has insufficient commission wallet balance for this trip'
      );
    END IF;

    UPDATE public.trips SET
      confirmed_driver_id = v_driver,
      scheduled_status = 'driver_assigned',
$inj$;
BEGIN
  SELECT pg_get_functiondef(
    'public.admin_scheduled_emergency_mutate(text,uuid,uuid,text,jsonb,jsonb)'::regprocedure
  ) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'admin_scheduled_emergency_mutate missing — cannot patch assign_now gates';
  END IF;
  IF position('driver_scheduled_commitment_gate(v_driver, p_trip_id' in v_def) > 0 THEN
    RAISE NOTICE 'admin_scheduled_emergency_mutate already carries assign_now commitment gate';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'admin_scheduled_emergency_mutate assign_now patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch$;

-- ── 2) Deferred assign_at execution (cron) — revalidate under same lock ──────
CREATE OR REPLACE FUNCTION public.execute_due_pending_scheduled_assign(
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_driver uuid;
  v_now timestamptz := now();
  v_n int := 0;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ID_REQUIRED');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF COALESCE(v_trip.pending_release_kind, '') <> 'assign'
     OR v_trip.pending_release_at IS NULL
     OR v_trip.pending_release_at > v_now
  THEN
    RETURN jsonb_build_object('success', false, 'error', 'PENDING_ASSIGN_NOT_DUE');
  END IF;

  v_driver := v_trip.pending_release_driver_id;
  IF v_driver IS NULL THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED', 'pending_cleared', true);
  END IF;

  -- Live ownership — clear stale pending; leave booking as-is.
  IF v_trip.driver_id IS NOT NULL THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_LIVE_ASSIGNED', 'pending_cleared', true);
  END IF;

  IF v_trip.completed_at IS NOT NULL OR v_trip.cancelled_at IS NOT NULL THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_TERMINAL', 'pending_cleared', true);
  END IF;

  -- Same per-driver key as accept_scheduled_ride / patched assign_now.
  PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver::text));

  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION WHEN OTHERS THEN
    -- Fail closed: clear deferred assign; caller may mark payment_gate_blocked.
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_GATE_NOT_SATISFIED',
      'message', SQLERRM,
      'pending_cleared', true
    );
  END;

  IF COALESCE(
       (public.driver_scheduled_commitment_gate(v_driver, p_trip_id, 'additional_scheduled') ->> 'allowed')::boolean,
       true
     ) = false
  THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'SCHEDULED_COMMITMENT_INFEASIBLE',
      'message', 'Deferred assign blocked: driver commitment infeasible at execution time.',
      'commitment_trip_id',
        public.driver_scheduled_commitment_gate(v_driver, p_trip_id, 'additional_scheduled') ->> 'commitment_trip_id',
      'pending_cleared', true
    );
  END IF;

  IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_driver, p_trip_id) THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
      'message', 'Deferred assign blocked: insufficient commission wallet at execution time.',
      'pending_cleared', true
    );
  END IF;

  UPDATE public.trips SET
    confirmed_driver_id = v_driver,
    scheduled_status = 'driver_assigned',
    scheduled_accepted_at = v_now,
    status = 'scheduled',
    driver_id = NULL,
    pending_release_kind = NULL,
    pending_release_at = NULL,
    pending_release_driver_id = NULL,
    updated_at = v_now
  WHERE id = p_trip_id
    AND driver_id IS NULL
    AND completed_at IS NULL
    AND pending_release_kind = 'assign'
    AND scheduled_status::text IN (
      'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
    );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND pending_release_kind = 'assign';
    RETURN jsonb_build_object('success', false, 'error', 'CAS_MISMATCH', 'pending_cleared', true);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'confirmed_driver_id', v_driver
  );
END;
$function$;

COMMENT ON FUNCTION public.execute_due_pending_scheduled_assign(uuid) IS
  'Cron execution of deferred Admin assign_at: payment + commitment + commission wallet under driver_sched_accept advisory lock. Ineligible → clear pending only (booking recoverable).';

REVOKE ALL ON FUNCTION public.execute_due_pending_scheduled_assign(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.execute_due_pending_scheduled_assign(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.execute_due_pending_scheduled_assign(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.execute_due_pending_scheduled_assign(uuid) TO service_role;
