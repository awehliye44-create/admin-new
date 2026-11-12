-- Phase 3 mandatory: emergency trip mutation + audit_logs in ONE transaction.
-- If audit insert fails, the trip UPDATE is rolled back (unchanged state).
-- DO NOT apply until production deploy approval / after prior Phase 3 migrations.
-- Edge admin-scheduled-ride-action must call this RPC after RBAC + payment/airport gates.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_scheduled_emergency_mutate(
  p_action text,
  p_trip_id uuid,
  p_actor_user_id uuid,
  p_reason text,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_action text := lower(btrim(COALESCE(p_action, '')));
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_trip public.trips%ROWTYPE;
  v_previous jsonb;
  v_resulting jsonb;
  v_now timestamptz := now();
  v_driver uuid;
  v_at timestamptz;
  v_kind text;
  v_cancel jsonb;
  v_n int := 0;
  v_is_service boolean := current_setting('request.jwt.claim.role', true) = 'service_role';
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ID_REQUIRED');
  END IF;
  IF p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACTOR_REQUIRED');
  END IF;
  IF char_length(v_reason) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  END IF;

  -- Staff JWT path: enforce page + action. Service-role trusted after Edge RBAC.
  IF NOT v_is_service THEN
    IF auth.uid() IS DISTINCT FROM p_actor_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTOR_MISMATCH');
    END IF;
    IF NOT public.staff_has_page_access('scheduled-rides') THEN
      RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Scheduled Rides page access required');
    END IF;
    IF v_action IN ('make_available_now', 'make_available_at')
       AND NOT public.staff_has_action(p_actor_user_id, 'scheduled_rides.make_available') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTION_PERMISSION_DENIED');
    ELSIF v_action IN ('assign_now', 'assign_at')
       AND NOT public.staff_has_action(p_actor_user_id, 'scheduled_rides.assign') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTION_PERMISSION_DENIED');
    ELSIF v_action IN ('broadcast_now', 'broadcast_at')
       AND NOT public.staff_has_action(p_actor_user_id, 'scheduled_rides.broadcast') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTION_PERMISSION_DENIED');
    ELSIF v_action = 'hold_exceptional'
       AND NOT public.staff_has_action(p_actor_user_id, 'scheduled_rides.hold') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTION_PERMISSION_DENIED');
    ELSIF v_action = 'cancel_pending_release'
       AND NOT public.staff_has_action(p_actor_user_id, 'scheduled_rides.cancel_pending') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTION_PERMISSION_DENIED');
    ELSIF v_action = 'cancel_ride'
       AND NOT public.staff_has_action(p_actor_user_id, 'scheduled_rides.cancel_ride') THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACTION_PERMISSION_DENIED');
    END IF;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  v_previous := jsonb_build_object(
    'scheduled_status', v_trip.scheduled_status,
    'status', v_trip.status,
    'scheduled_broadcast_at', v_trip.scheduled_broadcast_at,
    'broadcast_enabled', v_trip.broadcast_enabled,
    'scheduled_hold_reason', v_trip.scheduled_hold_reason,
    'pending_release_kind', v_trip.pending_release_kind,
    'pending_release_at', v_trip.pending_release_at,
    'pending_release_driver_id', v_trip.pending_release_driver_id,
    'confirmed_driver_id', v_trip.confirmed_driver_id,
    'driver_id', v_trip.driver_id,
    'dispatch_mode', v_trip.dispatch_mode
  );

  IF v_action = 'hold_exceptional' THEN
    IF v_trip.driver_id IS NOT NULL OR v_trip.completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;
    UPDATE public.trips SET
      scheduled_status = 'admin_held',
      scheduled_broadcast_at = NULL,
      scheduled_hold_reason = 'admin_exceptional',
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND driver_id IS NULL
      AND completed_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;

  ELSIF v_action = 'cancel_pending_release' THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;

  ELSIF v_action = 'make_available_now' THEN
    IF v_trip.driver_id IS NOT NULL OR v_trip.confirmed_driver_id IS NOT NULL OR v_trip.completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;
    UPDATE public.trips SET
      scheduled_status = 'scheduled',
      status = 'scheduled',
      scheduled_broadcast_at = v_now,
      dispatch_mode = 'scheduled',
      scheduled_hold_reason = NULL,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND driver_id IS NULL
      AND confirmed_driver_id IS NULL
      AND completed_at IS NULL
      AND scheduled_status::text IN ('admin_held', 'scheduled', 'pending');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;

  ELSIF v_action IN ('make_available_at', 'broadcast_at', 'assign_at') THEN
    v_at := NULLIF(p_meta->>'execute_at', '')::timestamptz;
    IF v_at IS NULL OR v_at <= v_now THEN
      RETURN jsonb_build_object('success', false, 'error', 'EXECUTE_AT_REQUIRED');
    END IF;
    v_kind := CASE v_action
      WHEN 'make_available_at' THEN 'jobs'
      WHEN 'broadcast_at' THEN 'broadcast'
      ELSE 'assign'
    END;
    v_driver := NULLIF(p_meta->>'driver_id', '')::uuid;
    IF v_kind = 'assign' AND v_driver IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED');
    END IF;
    IF v_trip.driver_id IS NOT NULL OR v_trip.completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;
    UPDATE public.trips SET
      pending_release_kind = v_kind,
      pending_release_at = v_at,
      pending_release_driver_id = CASE WHEN v_kind = 'assign' THEN v_driver ELSE NULL END,
      updated_at = v_now
    WHERE id = p_trip_id
      AND driver_id IS NULL
      AND completed_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;

  ELSIF v_action = 'assign_now' THEN
    v_driver := NULLIF(p_meta->>'driver_id', '')::uuid;
    IF v_driver IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED');
    END IF;
    IF v_trip.completed_at IS NOT NULL OR v_trip.cancelled_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_TERMINAL');
    END IF;
    IF v_trip.driver_id IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'ALREADY_LIVE_ASSIGNED');
    END IF;
    IF COALESCE(v_trip.scheduled_status::text, '') NOT IN (
      'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_STATE');
    END IF;
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
      AND scheduled_status::text IN (
        'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
      );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'CAS_MISMATCH');
    END IF;

  ELSIF v_action = 'broadcast_now' THEN
    -- Edge supplies conversion patch after airport/payment gates.
    IF COALESCE(p_patch, '{}'::jsonb) = '{}'::jsonb THEN
      RETURN jsonb_build_object('success', false, 'error', 'PATCH_REQUIRED');
    END IF;
    IF COALESCE((p_patch->>'broadcast_enabled')::boolean, true) IS FALSE THEN
      RETURN jsonb_build_object('success', false, 'error', 'AIRPORT_PRICING_UNRESOLVED');
    END IF;
    UPDATE public.trips t SET
      scheduled_status = COALESCE(p_patch->>'scheduled_status', t.scheduled_status::text),
      status = COALESCE(p_patch->>'status', t.status),
      dispatch_mode = COALESCE(p_patch->>'dispatch_mode', t.dispatch_mode),
      dispatch_status = COALESCE(p_patch->>'dispatch_status', t.dispatch_status),
      scheduled_broadcast_at = COALESCE((p_patch->>'scheduled_broadcast_at')::timestamptz, v_now),
      broadcast_enabled = COALESCE((p_patch->>'broadcast_enabled')::boolean, t.broadcast_enabled),
      searching_expires_at = COALESCE((p_patch->>'searching_expires_at')::timestamptz, t.searching_expires_at),
      current_broadcast_round = COALESCE((p_patch->>'current_broadcast_round')::int, t.current_broadcast_round),
      max_broadcast_rounds = COALESCE((p_patch->>'max_broadcast_rounds')::int, t.max_broadcast_rounds),
      confirmed_driver_id = NULL,
      driver_id = NULL,
      scheduled_hold_reason = NULL,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE t.id = p_trip_id
      AND t.driver_id IS NULL
      AND t.completed_at IS NULL
      AND t.scheduled_status::text IN ('admin_held', 'scheduled', 'pending', 'driver_assigned');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_NO_LONGER_ELIGIBLE');
    END IF;

  ELSIF v_action = 'cancel_ride' THEN
    IF v_trip.status = 'completed' OR v_trip.completed_at IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_COMPLETED');
    END IF;
    v_cancel := public.apply_terminal_trip_cancellation(p_trip_id, 'admin', v_reason);
    IF COALESCE((v_cancel->>'success')::boolean, true) IS FALSE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_cancel->>'error', 'CANCEL_FAILED'),
        'result', v_cancel
      );
    END IF;
    UPDATE public.trips SET
      scheduled_status = 'cancelled',
      confirmed_driver_id = NULL,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;

  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'UNSUPPORTED_ACTION', 'action', v_action);
  END IF;

  SELECT jsonb_build_object(
    'scheduled_status', scheduled_status,
    'status', status,
    'scheduled_broadcast_at', scheduled_broadcast_at,
    'broadcast_enabled', broadcast_enabled,
    'scheduled_hold_reason', scheduled_hold_reason,
    'pending_release_kind', pending_release_kind,
    'pending_release_at', pending_release_at,
    'pending_release_driver_id', pending_release_driver_id,
    'confirmed_driver_id', confirmed_driver_id,
    'driver_id', driver_id,
    'dispatch_mode', dispatch_mode
  )
  INTO v_resulting
  FROM public.trips
  WHERE id = p_trip_id;

  -- Same transaction: audit failure aborts the whole function → trip UPDATE rolled back.
  INSERT INTO public.audit_logs (event_type, user_id, trip_id, details)
  VALUES (
    'ADMIN_SCHEDULED_' || upper(v_action),
    p_actor_user_id,
    p_trip_id,
    jsonb_build_object(
      'reason', v_reason,
      'previous', v_previous,
      'resulting', v_resulting,
      'source', 'admin_scheduled_emergency_mutate',
      'at', v_now
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'action', v_action,
    'trip_id', p_trip_id,
    'previous', v_previous,
    'resulting', v_resulting,
    'confirmed_driver_id', v_resulting->>'confirmed_driver_id'
  );
END;
$fn$;

COMMENT ON FUNCTION public.admin_scheduled_emergency_mutate(text, uuid, uuid, text, jsonb, jsonb) IS
  'Phase 3: emergency scheduled action mutate + audit_logs in one transaction. Audit failure rolls back trip state.';

REVOKE ALL ON FUNCTION public.admin_scheduled_emergency_mutate(text, uuid, uuid, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_scheduled_emergency_mutate(text, uuid, uuid, text, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_scheduled_emergency_mutate(text, uuid, uuid, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_scheduled_emergency_mutate(text, uuid, uuid, text, jsonb, jsonb) TO service_role;

COMMIT;
