-- ============================================================
-- Scheduled journey future compliance eligibility
--
-- Extends the existing Europe/London document eligibility SSOT so a driver
-- who is eligible *today* is still rejected when required documents expire
-- before the scheduled journey's estimated completion.
--
-- Also: atomic compliance release of unactivated confirmed assignments back
-- to the Requested marketplace (or urgent convert), event-driven release on
-- document/account changes, and SQL gates on accept + admin assign.
-- ============================================================

-- ── 1) Documents valid through as-of (London calendar end-of-expiry-day) ─────
CREATE OR REPLACE FUNCTION public.check_driver_documents_valid_through(
  p_driver_id uuid,
  p_as_of timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_service_area_id uuid;
  v_as_of_london date;
  v_slug text;
  v_expiry_required boolean;
  v_status text;
  v_expiry date;
BEGIN
  IF p_driver_id IS NULL OR p_as_of IS NULL THEN
    RETURN false;
  END IF;

  -- Live "today" eligibility remains required (missing / rejected / pending).
  IF NOT public.check_driver_documents_approved(p_driver_id) THEN
    RETURN false;
  END IF;

  v_as_of_london := (p_as_of AT TIME ZONE 'Europe/London')::date;

  SELECT d.service_area_id INTO v_service_area_id
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF v_service_area_id IS NULL THEN
    RETURN false;
  END IF;

  FOR v_slug, v_expiry_required IN
    SELECT dt.slug, COALESCE(sar.expiry_required, true)
    FROM public.service_area_document_rules sar
    JOIN public.document_types dt ON dt.id = sar.doc_type_id
    WHERE sar.service_area_id = v_service_area_id
      AND sar.is_active = true
      AND COALESCE(sar.display_in_driver_app, true) = true
      AND sar.mandatory = true
      AND dt.is_active = true
  LOOP
    SELECT d.status, d.expiry_date
    INTO v_status, v_expiry
    FROM public.documents d
    WHERE d.driver_id = p_driver_id
      AND d.document_type = v_slug
      AND COALESCE(d.is_current, true) = true
    ORDER BY
      CASE WHEN d.status = 'approved' THEN 0 ELSE 1 END,
      d.updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_status IS NULL OR lower(trim(v_status)) <> 'approved' THEN
      RETURN false;
    END IF;

    IF v_expiry_required AND (v_expiry IS NULL OR v_expiry < v_as_of_london) THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.check_driver_documents_valid_through(uuid, timestamptz) IS
  'Mandatory docs approved and valid through Europe/London calendar date of p_as_of (end-of-expiry-day SSOT). Requires live check_driver_documents_approved first.';

REVOKE ALL ON FUNCTION public.check_driver_documents_valid_through(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_valid_through(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_valid_through(uuid, timestamptz) TO service_role;

-- ── 2) Account + journey-horizon assert ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_driver_scheduled_journey_compliance(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver RECORD;
  v_trip RECORD;
  v_end timestamptz;
  v_as_of_london date;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'INVALID_ARGS',
      'message', 'driver_id and trip_id required'
    );
  END IF;

  SELECT id, approval_status, driver_status, deleted_at
  INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'ACCOUNT_INELIGIBLE',
      'message', 'Driver account is not approved and active for scheduled bookings.'
    );
  END IF;

  IF v_driver.deleted_at IS NOT NULL
     OR lower(COALESCE(v_driver.approval_status::text, '')) <> 'approved'
     OR lower(COALESCE(v_driver.driver_status::text, '')) <> 'active'
  THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'ACCOUNT_INELIGIBLE',
      'message', 'Driver account is not approved and active for scheduled bookings.'
    );
  END IF;

  SELECT id, scheduled_at, estimated_duration_minutes, status, started_at
  INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'TRIP_NOT_FOUND',
      'message', 'Trip not found'
    );
  END IF;

  IF v_trip.started_at IS NOT NULL
     OR lower(COALESCE(v_trip.status::text, '')) IN (
       'in_progress', 'completed', 'cancelled'
     )
  THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'IN_PROGRESS_PROTECTED',
      'message', 'Active passenger journey is protected from scheduled compliance release.'
    );
  END IF;

  IF v_trip.scheduled_at IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'INVALID_SCHEDULED_AT',
      'message', 'Scheduled pickup time is invalid.'
    );
  END IF;

  IF NOT public.check_driver_documents_approved(p_driver_id) THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'DOCUMENTS_NOT_APPROVED',
      'message', 'One or more required documents is not approved or has expired.',
      'expired_documents', '[]'::jsonb
    );
  END IF;

  v_end := public.trip_schedule_estimated_end(
    v_trip.scheduled_at,
    COALESCE(v_trip.estimated_duration_minutes, 30)
  );

  IF NOT public.check_driver_documents_valid_through(p_driver_id, v_end) THEN
    v_as_of_london := (v_end AT TIME ZONE 'Europe/London')::date;
    RETURN jsonb_build_object(
      'allowed', false,
      'code', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
      'message', 'Required documents do not remain valid through the scheduled journey.',
      'journey_end_iso', v_end,
      'as_of_london_date', v_as_of_london,
      'expired_documents', '[]'::jsonb
    );
  END IF;

  v_as_of_london := (v_end AT TIME ZONE 'Europe/London')::date;
  RETURN jsonb_build_object(
    'allowed', true,
    'code', 'OK',
    'message', '',
    'journey_end_iso', v_end,
    'as_of_london_date', v_as_of_london,
    'expired_documents', '[]'::jsonb
  );
END;
$function$;

COMMENT ON FUNCTION public.assert_driver_scheduled_journey_compliance(uuid, uuid) IS
  'Account + live docs + docs valid through trip_schedule_estimated_end (London). Authoritative scheduled accept/assign gate.';

REVOKE ALL ON FUNCTION public.assert_driver_scheduled_journey_compliance(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_driver_scheduled_journey_compliance(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_driver_scheduled_journey_compliance(uuid, uuid) TO service_role;

-- Boolean gate for accept/assign (single eval).
CREATE OR REPLACE FUNCTION public.driver_eligible_for_scheduled_journey(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (public.assert_driver_scheduled_journey_compliance(p_driver_id, p_trip_id)->>'allowed')::boolean,
    false
  );
$function$;

COMMENT ON FUNCTION public.driver_eligible_for_scheduled_journey(uuid, uuid) IS
  'True when assert_driver_scheduled_journey_compliance.allowed — accept/admin/JIT gate.';

REVOKE ALL ON FUNCTION public.driver_eligible_for_scheduled_journey(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_eligible_for_scheduled_journey(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_eligible_for_scheduled_journey(uuid, uuid) TO service_role;

-- ── 3) Atomic compliance release (unactivated confirmed only) ────────────────
CREATE OR REPLACE FUNCTION public.release_scheduled_assignment_for_compliance(
  p_trip_id uuid,
  p_expected_driver_id uuid,
  p_reason text DEFAULT 'compliance_ineligible',
  p_urgent boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_now timestamptz := now();
  v_broadcast_at timestamptz;
  v_n int := 0;
BEGIN
  IF p_trip_id IS NULL OR p_expected_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ARGS');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  -- Idempotent: already unassigned
  IF v_trip.confirmed_driver_id IS NULL AND v_trip.driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'released', false,
      'idempotent', true,
      'error', 'ALREADY_RELEASED'
    );
  END IF;

  -- Protect activated / in-progress journeys (use existing rematch paths).
  IF v_trip.started_at IS NOT NULL
     OR v_trip.driver_id IS NOT NULL
     OR lower(COALESCE(v_trip.status::text, '')) IN (
       'in_progress', 'en_route_to_pickup', 'arrived', 'arrived_at_pickup',
       'completed', 'cancelled'
     )
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'IN_PROGRESS_PROTECTED'
    );
  END IF;

  IF v_trip.confirmed_driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'DRIVER_MISMATCH'
    );
  END IF;

  IF COALESCE(v_trip.scheduled_status::text, '') NOT IN (
    'driver_assigned', 'scheduled_committed', 'awaiting_activation_accept', 'scheduled'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'INVALID_STATE',
      'scheduled_status', v_trip.scheduled_status
    );
  END IF;

  -- Exclude ineligible driver from reconfirming this booking.
  BEGIN
    PERFORM public.decline_scheduled_ride(p_trip_id, p_expected_driver_id, COALESCE(p_reason, 'compliance_ineligible'));
  EXCEPTION WHEN OTHERS THEN
    -- Best-effort exclusion; still release assignment.
    NULL;
  END;

  v_broadcast_at := COALESCE(v_trip.scheduled_broadcast_at, v_now);

  IF p_urgent AND COALESCE(v_trip.broadcast_enabled, true) = true THEN
    UPDATE public.trips SET
      driver_id = NULL,
      confirmed_driver_id = NULL,
      cancelled_at = NULL,
      cancelled_by = NULL,
      dispatch_mode = 'instant',
      scheduled_status = 'converted_to_instant',
      status = 'searching',
      scheduled_broadcast_at = v_now,
      broadcast_started_at = v_now,
      current_offer_driver_id = NULL,
      current_offer_expires_at = NULL,
      commitment_time = NULL,
      scheduled_committed_at = NULL,
      scheduled_jit_activate_at = NULL,
      scheduled_jit_eta_minutes = NULL,
      scheduled_jit_eta_observed_at = NULL,
      scheduled_jit_distance_kind = NULL,
      scheduled_jit_eta_source = NULL,
      scheduled_jit_basis_scheduled_at = NULL,
      scheduled_jit_eta_spike_samples = 0,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND confirmed_driver_id = p_expected_driver_id
      AND driver_id IS NULL
      AND started_at IS NULL;
  ELSE
    UPDATE public.trips SET
      driver_id = NULL,
      confirmed_driver_id = NULL,
      cancelled_at = NULL,
      cancelled_by = NULL,
      scheduled_status = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN 'broadcasting'
        ELSE 'admin_held'
      END,
      status = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN 'offered'
        ELSE 'scheduled'
      END,
      dispatch_mode = 'scheduled',
      scheduled_broadcast_at = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN v_broadcast_at
        ELSE NULL
      END,
      dispatch_status = 'available',
      current_offer_driver_id = NULL,
      current_offer_expires_at = NULL,
      commitment_time = NULL,
      scheduled_committed_at = NULL,
      scheduled_driver_risk = false,
      scheduled_jit_activate_at = NULL,
      scheduled_jit_eta_minutes = NULL,
      scheduled_jit_eta_observed_at = NULL,
      scheduled_jit_distance_kind = NULL,
      scheduled_jit_eta_source = NULL,
      scheduled_jit_basis_scheduled_at = NULL,
      scheduled_jit_eta_spike_samples = 0,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND confirmed_driver_id = p_expected_driver_id
      AND driver_id IS NULL
      AND started_at IS NULL;
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'CAS_MISMATCH'
    );
  END IF;

  -- Revoke pending activation offers for this driver on this trip.
  UPDATE public.ride_offers
  SET status = 'cancelled', updated_at = v_now
  WHERE trip_id = p_trip_id
    AND driver_id = p_expected_driver_id
    AND status IN ('pending', 'offered', 'countered');

  INSERT INTO public.audit_logs (event_type, driver_id, trip_id, details)
  VALUES (
    'scheduled_job_compliance_released',
    p_expected_driver_id,
    p_trip_id,
    jsonb_build_object(
      'reason', COALESCE(p_reason, 'compliance_ineligible'),
      'urgent', COALESCE(p_urgent, false),
      'at', v_now
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'released', true,
    'urgent', COALESCE(p_urgent, false),
    'trip_id', p_trip_id,
    'driver_id', p_expected_driver_id
  );
END;
$function$;

COMMENT ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) IS
  'Atomically clear unactivated confirmed scheduled assignment for compliance; exclude driver; reopen marketplace or urgent convert. No fare/payment mutation. No cancellation of customer booking.';

REVOKE ALL ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) TO service_role;

-- ── 4) Release all ineligible future confirmed bookings for a driver ─────────
CREATE OR REPLACE FUNCTION public.release_ineligible_scheduled_assignments_for_driver(
  p_driver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
  v_assert jsonb;
  v_release jsonb;
  v_released int := 0;
  v_scanned int := 0;
  v_urgent boolean;
  v_minutes numeric;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED');
  END IF;

  FOR v_row IN
    SELECT t.id, t.scheduled_at, t.confirmed_driver_id
    FROM public.trips t
    WHERE t.confirmed_driver_id = p_driver_id
      AND t.driver_id IS NULL
      AND t.started_at IS NULL
      AND t.completed_at IS NULL
      AND t.cancelled_at IS NULL
      AND COALESCE(t.is_scheduled, false) = true
      AND COALESCE(t.dispatch_mode::text, '') = 'scheduled'
      AND t.scheduled_at IS NOT NULL
      AND t.scheduled_at > now()
      AND COALESCE(t.scheduled_status::text, '') IN (
        'driver_assigned', 'scheduled_committed', 'awaiting_activation_accept'
      )
    ORDER BY t.scheduled_at ASC
    LIMIT 50
  LOOP
    v_scanned := v_scanned + 1;
    v_assert := public.assert_driver_scheduled_journey_compliance(p_driver_id, v_row.id);
    IF COALESCE((v_assert->>'allowed')::boolean, false) = true THEN
      CONTINUE;
    END IF;
    IF COALESCE(v_assert->>'code', '') = 'IN_PROGRESS_PROTECTED' THEN
      CONTINUE;
    END IF;

    v_minutes := EXTRACT(EPOCH FROM (v_row.scheduled_at - now())) / 60.0;
    v_urgent := v_minutes <= 9;

    v_release := public.release_scheduled_assignment_for_compliance(
      v_row.id,
      p_driver_id,
      COALESCE(v_assert->>'code', 'compliance_ineligible'),
      v_urgent
    );
    IF COALESCE((v_release->>'released')::boolean, false) THEN
      v_released := v_released + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'scanned', v_scanned,
    'released', v_released
  );
END;
$function$;

COMMENT ON FUNCTION public.release_ineligible_scheduled_assignments_for_driver(uuid) IS
  'Event-driven / reconcile: release unactivated confirmed scheduled bookings the driver can no longer perform through journey end.';

REVOKE ALL ON FUNCTION public.release_ineligible_scheduled_assignments_for_driver(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_ineligible_scheduled_assignments_for_driver(uuid) TO service_role;

-- ── 5) Patch accept_scheduled_ride — journey compliance after live docs ──────
DO $patch_accept$
DECLARE
  v_def text;
  v_marker text :=
$m$
  IF NOT public.check_driver_documents_approved(v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_NOT_APPROVED',
      'message', 'One or more of your documents has expired or is not approved. Renew them before accepting scheduled rides.'
    );
  END IF;
$m$;
  v_inject text :=
$inj$
  IF NOT public.check_driver_documents_approved(v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_NOT_APPROVED',
      'message', 'One or more of your documents has expired or is not approved. Renew them before accepting scheduled rides.'
    );
  END IF;

  -- Future-horizon: docs must remain valid through estimated journey end.
  IF NOT public.driver_eligible_for_scheduled_journey(v_driver_id, p_trip_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
      'message', 'Required documents do not remain valid through the scheduled journey.'
    );
  END IF;
$inj$;
BEGIN
  IF to_regprocedure('public.accept_scheduled_ride(uuid,uuid)') IS NULL THEN
    RAISE NOTICE 'accept_scheduled_ride(uuid,uuid) missing — skip journey compliance patch';
    RETURN;
  END IF;
  SELECT pg_get_functiondef('public.accept_scheduled_ride(uuid,uuid)'::regprocedure)
  INTO v_def;
  IF v_def IS NULL THEN
    RAISE NOTICE 'accept_scheduled_ride def missing — skip';
    RETURN;
  END IF;
  IF position('driver_eligible_for_scheduled_journey' in v_def) > 0 THEN
    RAISE NOTICE 'accept_scheduled_ride already carries journey compliance';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE NOTICE 'accept_scheduled_ride docs marker not found — skip journey compliance patch';
    RETURN;
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch_accept$;

-- ── 6) Patch admin_assign_scheduled_driver — same journey compliance ─────────
DO $patch_admin$
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

  UPDATE public.trips
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

  IF NOT public.driver_eligible_for_scheduled_journey(p_driver_id, p_trip_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
      'message', 'Driver is not eligible for this scheduled journey (account or documents).'
    );
  END IF;

  UPDATE public.trips
$inj$;
BEGIN
  IF to_regprocedure('public.admin_assign_scheduled_driver(uuid,uuid)') IS NULL THEN
    RAISE NOTICE 'admin_assign_scheduled_driver missing — skip (Admin assign uses emergency_mutate path)';
    RETURN;
  END IF;
  SELECT pg_get_functiondef('public.admin_assign_scheduled_driver(uuid,uuid)'::regprocedure)
  INTO v_def;
  IF v_def IS NULL THEN
    RAISE NOTICE 'admin_assign_scheduled_driver def missing — skip';
    RETURN;
  END IF;
  IF position('driver_eligible_for_scheduled_journey' in v_def) > 0 THEN
    RAISE NOTICE 'admin_assign_scheduled_driver already carries journey compliance';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE NOTICE 'admin_assign_scheduled_driver payment marker not found — skip';
    RETURN;
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch_admin$;

-- ── 6b) Patch admin_scheduled_emergency_mutate assign_now (primary Admin path)
DO $patch_emergency_assign$
DECLARE
  v_def text;
  v_marker text :=
$m$
    -- Serialize with marketplace accept_scheduled_ride / accept_ride_offer.
    PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver::text));
$m$;
  v_inject text :=
$inj$
    -- Serialize with marketplace accept_scheduled_ride / accept_ride_offer.
    PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver::text));

    IF NOT public.driver_eligible_for_scheduled_journey(v_driver, p_trip_id) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
        'message', 'Driver is not eligible for this scheduled journey (account or documents).'
      );
    END IF;
$inj$;
BEGIN
  IF to_regprocedure(
    'public.admin_scheduled_emergency_mutate(text,uuid,uuid,text,jsonb,jsonb)'
  ) IS NULL THEN
    RAISE NOTICE 'admin_scheduled_emergency_mutate missing — skip assign_now compliance';
    RETURN;
  END IF;
  SELECT pg_get_functiondef(
    'public.admin_scheduled_emergency_mutate(text,uuid,uuid,text,jsonb,jsonb)'::regprocedure
  ) INTO v_def;
  IF v_def IS NULL THEN
    RAISE NOTICE 'admin_scheduled_emergency_mutate def missing — skip assign_now compliance';
    RETURN;
  END IF;
  IF position('driver_eligible_for_scheduled_journey(v_driver, p_trip_id)' in v_def) > 0 THEN
    RAISE NOTICE 'admin_scheduled_emergency_mutate already carries journey compliance';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    -- Fallback: inject after payment gate when commitment lock patch absent.
    v_marker :=
$m2$
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
$m2$;
    v_inject :=
$inj2$
    BEGIN
      PERFORM public.assert_payment_gate(p_trip_id);
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'PAYMENT_GATE_NOT_SATISFIED',
        'message', SQLERRM
      );
    END;

    IF NOT public.driver_eligible_for_scheduled_journey(v_driver, p_trip_id) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
        'message', 'Driver is not eligible for this scheduled journey (account or documents).'
      );
    END IF;

    UPDATE public.trips SET
      confirmed_driver_id = v_driver,
$inj2$;
    IF position(v_marker in v_def) = 0 THEN
      RAISE NOTICE 'admin_scheduled_emergency_mutate assign_now marker not found — skip';
      RETURN;
    END IF;
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch_emergency_assign$;

-- ── 7) Deferred assign_at — revalidate journey compliance at execution ───────
DO $patch_deferred$
DECLARE
  v_def text;
  v_marker text :=
$m$
  IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_driver, p_trip_id) THEN
$m$;
  v_inject text :=
$inj$
  IF NOT public.driver_eligible_for_scheduled_journey(v_driver, p_trip_id) THEN
    UPDATE public.trips SET
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
      'message', 'Deferred assign blocked: driver not eligible through journey end.',
      'pending_cleared', true
    );
  END IF;

  IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_driver, p_trip_id) THEN
$inj$;
BEGIN
  IF to_regprocedure('public.execute_due_pending_scheduled_assign(uuid)') IS NULL THEN
    RAISE NOTICE 'execute_due_pending_scheduled_assign missing — skip deferred compliance patch';
    RETURN;
  END IF;
  SELECT pg_get_functiondef('public.execute_due_pending_scheduled_assign(uuid)'::regprocedure)
  INTO v_def;
  IF v_def IS NULL THEN
    RAISE NOTICE 'execute_due_pending_scheduled_assign def missing — skip';
    RETURN;
  END IF;
  IF position('driver_eligible_for_scheduled_journey' in v_def) > 0 THEN
    RAISE NOTICE 'execute_due_pending_scheduled_assign already carries journey compliance';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE NOTICE 'execute_due_pending_scheduled_assign wallet marker not found — skip';
    RETURN;
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch_deferred$;

-- ── 8) Event-driven: document recalc + status trigger release confirmed ──────
CREATE OR REPLACE FUNCTION public.recalculate_driver_documents_approved_internal(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_approved boolean;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN false;
  END IF;

  v_approved := public.check_driver_documents_approved(p_driver_id);

  UPDATE public.drivers d
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE d.id = p_driver_id
    AND (
      d.documents_approved IS DISTINCT FROM v_approved
      OR d.onboarding_complete IS DISTINCT FROM v_approved
    );

  IF v_approved = false THEN
    PERFORM public.force_driver_offline_for_document_ineligibility(p_driver_id);
  END IF;

  -- Future-horizon: even if still approved *today*, release bookings whose
  -- journey end falls after document expiry (or account/docs now blocking).
  PERFORM public.release_ineligible_scheduled_assignments_for_driver(p_driver_id);

  RETURN v_approved;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_driver_document_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := COALESCE(NEW.driver_id, OLD.driver_id);
  v_approved boolean;
BEGIN
  IF v_driver_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_approved := public.check_driver_documents_approved(v_driver_id);

  UPDATE public.drivers
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE id = v_driver_id
    AND (
      documents_approved IS DISTINCT FROM v_approved
      OR onboarding_complete IS DISTINCT FROM v_approved
    );

  IF v_approved = false THEN
    PERFORM public.force_driver_offline_for_document_ineligibility(v_driver_id);
  END IF;

  PERFORM public.release_ineligible_scheduled_assignments_for_driver(v_driver_id);

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Account suspension / disable / approval loss → release confirmed scheduled.
CREATE OR REPLACE FUNCTION public.release_scheduled_on_driver_account_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.approval_status IS DISTINCT FROM OLD.approval_status)
       OR (NEW.driver_status IS DISTINCT FROM OLD.driver_status)
       OR (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
    THEN
      PERFORM public.release_ineligible_scheduled_assignments_for_driver(NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_release_scheduled_on_driver_account_change ON public.drivers;
CREATE TRIGGER trg_release_scheduled_on_driver_account_change
  AFTER UPDATE OF approval_status, driver_status, deleted_at ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.release_scheduled_on_driver_account_change();

-- ── 9) Periodic reconcile helper (invoked from scheduled-dispatch Edge) ──────
CREATE OR REPLACE FUNCTION public.reconcile_scheduled_journey_compliance(
  p_limit integer DEFAULT 40
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
  v_assert jsonb;
  v_release jsonb;
  v_released int := 0;
  v_scanned int := 0;
  v_urgent boolean;
  v_minutes numeric;
  v_lim int := GREATEST(1, LEAST(COALESCE(p_limit, 40), 100));
BEGIN
  FOR v_row IN
    SELECT t.id, t.scheduled_at, t.confirmed_driver_id
    FROM public.trips t
    WHERE t.confirmed_driver_id IS NOT NULL
      AND t.driver_id IS NULL
      AND t.started_at IS NULL
      AND t.completed_at IS NULL
      AND t.cancelled_at IS NULL
      AND COALESCE(t.is_scheduled, false) = true
      AND COALESCE(t.dispatch_mode::text, '') = 'scheduled'
      AND t.scheduled_at IS NOT NULL
      AND t.scheduled_at > now()
      AND COALESCE(t.scheduled_status::text, '') IN (
        'driver_assigned', 'scheduled_committed', 'awaiting_activation_accept'
      )
    ORDER BY t.scheduled_at ASC
    LIMIT v_lim
  LOOP
    v_scanned := v_scanned + 1;
    v_assert := public.assert_driver_scheduled_journey_compliance(
      v_row.confirmed_driver_id,
      v_row.id
    );
    IF COALESCE((v_assert->>'allowed')::boolean, false) = true THEN
      CONTINUE;
    END IF;
    IF COALESCE(v_assert->>'code', '') = 'IN_PROGRESS_PROTECTED' THEN
      CONTINUE;
    END IF;

    v_minutes := EXTRACT(EPOCH FROM (v_row.scheduled_at - now())) / 60.0;
    v_urgent := v_minutes <= 9;

    v_release := public.release_scheduled_assignment_for_compliance(
      v_row.id,
      v_row.confirmed_driver_id,
      COALESCE(v_assert->>'code', 'compliance_ineligible'),
      v_urgent
    );
    IF COALESCE((v_release->>'released')::boolean, false) THEN
      v_released := v_released + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'scanned', v_scanned,
    'released', v_released
  );
END;
$function$;

COMMENT ON FUNCTION public.reconcile_scheduled_journey_compliance(integer) IS
  'Bounded idempotent sweep of unactivated confirmed scheduled bookings for journey-horizon compliance.';

REVOKE ALL ON FUNCTION public.reconcile_scheduled_journey_compliance(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_scheduled_journey_compliance(integer) TO service_role;
