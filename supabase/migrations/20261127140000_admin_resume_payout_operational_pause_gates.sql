-- ============================================================
-- Harden admin_set_driver_payout_operational_pause RESUME gates.
-- Forward-only REPLACE of the Stage B1 RPC. Does not edit applied history.
--
-- Resume (p_paused=false) fail-closed in one transaction with driver FOR UPDATE:
--   - active PROVIDER_VERIFIED destination required
--   - no ACTIVE reservation
--   - no in-flight / UNKNOWN payout item execution
--   - no unresolved payment_sessions.provider_state = UNKNOWN
--   - lifetime trip stamp vs TEN+tip variance must be 0 (else CREDIT_MISMATCH)
--   - if trip/ledger evidence cannot be established → FINANCIAL_READINESS_UNKNOWN
-- Pause (p_paused=true): finance ACL only; does not cancel in-flight money.
-- Never mutates wallet ledger, destinations, payouts, reservations, sessions.
-- Never invokes scheduler / executor / Revolut.
-- Direct client UPDATEs of pause fields denied via trigger (RPC sets GUC).
-- ============================================================

BEGIN;

-- Deny direct client/table updates of operational pause fields.
CREATE OR REPLACE FUNCTION public.deny_direct_driver_payout_pause_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $trig$
BEGIN
  -- Unrelated column updates never fire this trigger (UPDATE OF pause fields only).
  -- service_role: allow migrations / repair paths.
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;
  -- Canonical Admin RPC sets this GUC for the transaction.
  IF current_setting('onecab.allow_payout_operational_pause_write', true) = '1' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (
       NEW.payout_operational_paused IS DISTINCT FROM OLD.payout_operational_paused
       OR NEW.payouts_enabled IS DISTINCT FROM OLD.payouts_enabled
     )
  THEN
    RAISE EXCEPTION 'direct_payout_pause_write_denied'
      USING ERRCODE = '42501',
            HINT = 'Use public.admin_set_driver_payout_operational_pause';
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS trg_deny_direct_driver_payout_pause_write ON public.drivers;
CREATE TRIGGER trg_deny_direct_driver_payout_pause_write
  BEFORE UPDATE OF payout_operational_paused, payouts_enabled ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_direct_driver_payout_pause_write();

CREATE OR REPLACE FUNCTION public.admin_set_driver_payout_operational_pause(
  p_driver_id uuid,
  p_paused boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_before_paused boolean;
  v_before_legacy boolean;
  v_after_legacy boolean;
  v_unchanged boolean := false;
  v_dest_ok boolean := false;
  v_active_reservation_count integer := 0;
  v_inflight_payout_count integer := 0;
  v_inflight_intent_count integer := 0;
  v_unknown_provider_session_count integer := 0;
  v_intent_ssot_present boolean := false;
  v_expected_pence bigint := 0;
  v_actual_credits_pence bigint := 0;
  v_trip_count integer := 0;
  v_ledger_credit_count integer := 0;
  v_staff_role text;
  v_staff_id uuid;
  v_sa_ok boolean := false;
  v_gate_snapshot jsonb;
BEGIN
  PERFORM public.assert_finance_payout_ledger_access();

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id_required' USING ERRCODE = '22023';
  END IF;

  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'paused_required' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_required_3_to_500_chars' USING ERRCODE = '22023';
  END IF;

  -- Service-area scope: super_admin company-wide; others must overlap driver's areas.
  SELECT sp.id, sp.role::text
  INTO v_staff_id, v_staff_role
  FROM public.staff_profiles sp
  WHERE sp.user_id = v_actor
    AND sp.is_active IS TRUE
  LIMIT 1;

  IF v_staff_id IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_staff_role = 'super_admin' THEN
    v_sa_ok := true;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.driver_service_areas dsa
      JOIN public.staff_service_areas ssa
        ON ssa.service_area_id = dsa.service_area_id
       AND ssa.staff_id = v_staff_id
      WHERE dsa.driver_id = p_driver_id
    ) INTO v_sa_ok;
  END IF;

  IF NOT v_sa_ok THEN
    RAISE EXCEPTION 'service_area_scope_denied' USING ERRCODE = '42501';
  END IF;

  -- Canonical per-driver payout occupancy lock (same key as
  -- trg_payout_item_ledger_allocations_validate / weekly+early allocation).
  -- Acquire BEFORE destination / recon / intent / reservation reads and before
  -- clearing operational pause — closes Resume↔reserve eligibility races.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_driver_id::text, 0));

  -- Row lock for concurrent double-click / idempotent Resume.
  SELECT
    coalesce(d.payout_operational_paused, false),
    coalesce(d.payouts_enabled, false)
  INTO v_before_paused, v_before_legacy
  FROM public.drivers d
  WHERE d.id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.driver_payout_destinations p
    WHERE p.driver_id = p_driver_id
      AND p.is_active IS TRUE
      AND p.archived_at IS NULL
      AND upper(coalesce(p.provider_link_status, '')) = 'PROVIDER_VERIFIED'
      AND upper(coalesce(p.verification_status, '')) = 'PROVIDER_VERIFIED'
      AND p.provider_counterparty_id IS NOT NULL
  ) INTO v_dest_ok;

  SELECT count(*)::integer INTO v_active_reservation_count
  FROM public.driver_payout_reservations r
  WHERE r.driver_id = p_driver_id
    AND upper(coalesce(r.status, '')) = 'ACTIVE';

  SELECT count(*)::integer INTO v_inflight_payout_count
  FROM public.payout_items i
  WHERE i.driver_id = p_driver_id
    AND (
      upper(coalesce(i.status, '')) IN (
        'SUBMITTED', 'PROCESSING', 'PENDING', 'QUEUED', 'IN_FLIGHT', 'AUTHORIZED'
      )
      OR upper(coalesce(i.execution_status, '')) IN (
        'SUBMITTED', 'SUBMITTING', 'PROCESSING', 'UNKNOWN', 'PENDING', 'QUEUED'
      )
    );

  -- Canonical payout submission intent SSOT.
  v_intent_ssot_present := to_regclass('public.driver_payout_payment_intents') IS NOT NULL;
  IF v_intent_ssot_present THEN
    SELECT count(*)::integer INTO v_inflight_intent_count
    FROM public.driver_payout_payment_intents dpi
    WHERE dpi.driver_id = p_driver_id
      AND upper(coalesce(dpi.execution_status, '')) IN (
        'DRAFT', 'VALIDATED', 'BLOCKED', 'READY', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'
      );
  ELSE
    v_inflight_intent_count := 0;
  END IF;

  SELECT count(*)::integer INTO v_unknown_provider_session_count
  FROM public.payment_sessions ps
  JOIN public.trips t ON t.id = ps.trip_id
  WHERE (t.confirmed_driver_id = p_driver_id OR t.driver_id = p_driver_id)
    AND upper(coalesce(ps.provider_state, '')) = 'UNKNOWN';

  SELECT
    coalesce(sum(
      greatest(0, coalesce(t.driver_net_pence, 0))
      + greatest(0, coalesce(t.tip_pence, t.tip_amount_pence, 0))
    ), 0),
    count(*)::integer
  INTO v_expected_pence, v_trip_count
  FROM public.trips t
  WHERE t.status = 'completed'
    AND (t.confirmed_driver_id = p_driver_id OR t.driver_id = p_driver_id);

  SELECT
    coalesce(sum(greatest(0, l.amount_pence)), 0),
    count(*)::integer
  INTO v_actual_credits_pence, v_ledger_credit_count
  FROM public.driver_wallet_ledger l
  WHERE l.driver_id = p_driver_id
    AND upper(coalesce(l.type, '')) IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT');

  v_gate_snapshot := jsonb_build_object(
    'destination_provider_verified', v_dest_ok,
    'active_reservation_count', v_active_reservation_count,
    'inflight_payout_item_count', v_inflight_payout_count,
    'inflight_payment_intent_count', v_inflight_intent_count,
    'intent_ssot_present', v_intent_ssot_present,
    'unknown_provider_session_count', v_unknown_provider_session_count,
    'lifetime_expected_payable_pence', v_expected_pence,
    'lifetime_ten_plus_tip_credits_pence', v_actual_credits_pence,
    'lifetime_completed_trip_count', v_trip_count,
    'lifetime_credit_ledger_rows', v_ledger_credit_count,
    'lifetime_credit_variance_pence', v_actual_credits_pence - v_expected_pence,
    'service_area_scope_ok', v_sa_ok,
    'staff_role', v_staff_role,
    'canonical_payout_lock', 'pg_advisory_xact_lock(hashtextextended(driver_id::text, 0))'
  );

  IF p_paused IS FALSE THEN
    IF NOT v_intent_ssot_present THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'FINANCIAL_READINESS_UNKNOWN',
        'message', 'Resume blocked: driver_payout_payment_intents SSOT missing.',
        'gates', v_gate_snapshot
      );
    END IF;

    IF NOT v_dest_ok THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'DESTINATION_NOT_PROVIDER_VERIFIED',
        'message', 'Resume blocked: no active PROVIDER_VERIFIED payout destination.',
        'gates', v_gate_snapshot
      );
    END IF;

    IF v_active_reservation_count > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'ACTIVE_RESERVATION',
        'message', 'Resume blocked: an ACTIVE payout reservation exists.',
        'gates', v_gate_snapshot
      );
    END IF;

    IF v_inflight_payout_count > 0 OR v_inflight_intent_count > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'PAYOUT_IN_FLIGHT',
        'message', 'Resume blocked: a payout item or payment intent is already in flight / UNKNOWN.',
        'gates', v_gate_snapshot
      );
    END IF;

    IF v_unknown_provider_session_count > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'PROVIDER_UNKNOWN',
        'message', 'Resume blocked: unresolved payment session provider UNKNOWN exists.',
        'gates', v_gate_snapshot
      );
    END IF;

    IF v_trip_count = 0 AND v_ledger_credit_count = 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'FINANCIAL_READINESS_UNKNOWN',
        'message', 'Resume blocked: financial readiness cannot be established from trip/ledger evidence.',
        'gates', v_gate_snapshot
      );
    END IF;

    IF v_actual_credits_pence IS DISTINCT FROM v_expected_pence THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'CREDIT_MISMATCH',
        'message', 'Resume blocked: lifetime wallet credits do not match trip entitlement stamps.',
        'gates', v_gate_snapshot
      );
    END IF;
  END IF;

  v_after_legacy := NOT p_paused;

  IF v_before_paused IS NOT DISTINCT FROM p_paused
     AND v_before_legacy IS NOT DISTINCT FROM v_after_legacy THEN
    v_unchanged := true;
  ELSE
    PERFORM set_config('onecab.allow_payout_operational_pause_write', '1', true);
    UPDATE public.drivers d
    SET
      payout_operational_paused = p_paused,
      payouts_enabled = v_after_legacy,
      updated_at = now()
    WHERE d.id = p_driver_id;
  END IF;

  IF NOT v_unchanged THEN
    INSERT INTO public.payout_audit_log (
      driver_id,
      payout_type,
      event_type,
      metadata
    ) VALUES (
      p_driver_id,
      'operational_pause',
      CASE
        WHEN p_paused THEN 'DRIVER_PAYOUT_OPERATIONAL_PAUSE'
        ELSE 'DRIVER_PAYOUT_OPERATIONAL_RESUME'
      END,
      jsonb_build_object(
        'actor_user_id', v_actor,
        'reason', v_reason,
        'before', jsonb_build_object(
          'payout_operational_paused', v_before_paused,
          'payouts_enabled', v_before_legacy
        ),
        'after', jsonb_build_object(
          'payout_operational_paused', p_paused,
          'payouts_enabled', v_after_legacy
        ),
        'gates', v_gate_snapshot,
        'in_flight_noted_on_pause', CASE
          WHEN p_paused AND (v_active_reservation_count > 0 OR v_inflight_payout_count > 0)
          THEN true ELSE false
        END,
        'destination_mutated', false,
        'wallet_mutated', false,
        'provider_mutated', false,
        'scheduler_invoked', false
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'payout_operational_paused', p_paused,
    'payouts_enabled', v_after_legacy,
    'unchanged', v_unchanged,
    'gates', v_gate_snapshot
  );
END;
$function$;

COMMENT ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) IS
  'Authorised Admin pause/resume. Resume fail-closed on destination/reservation/in-flight/provider UNKNOWN/credit mismatch/unknown readiness. Dual-writes payout_operational_paused + legacy payouts_enabled. Direct client pause writes denied. Never mutates wallet/payouts/provider; never invokes scheduler.';

ALTER FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) TO authenticated;

COMMIT;
