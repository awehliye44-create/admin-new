-- DRAFT ONLY — do not apply without separate approval.
-- Version 20261201120000 (globally unused; live 20261130120000 = capture_composition_components).
--
-- Decision A: reuse existing trips.financial_outcome text column.
-- Exact DDL:
--   1) COMMENT ON COLUMN public.trips.financial_outcome
--   2) ALTER CHECK driver_financial_repair_audit.event_type (+2 values)
--   3) CREATE FUNCTION public.admin_apply_certification_non_payable_repair(...)
--   4) REVOKE ALL / GRANT EXECUTE TO service_role only
-- Not changed: financial_outcome CHECK/enum (none exists), invoice CHECK (none),
-- trips indexes, trips grants, ownership triggers, new outcome columns.
--
-- Rollback: rollback/rollback_20261201120000_certification_non_payable_financial_outcome.sql

BEGIN;

COMMENT ON COLUMN public.trips.financial_outcome IS
  'Canonical financial outcome (unconstrained text). Known values include COMPLETED, '
  'NO_SHOW, CANCELLED_WITH_FEE, CANCELLED_NO_FEE, LATE_PASSENGER_CANCELLATION, '
  'CERTIFICATION_NON_PAYABLE. CERTIFICATION_NON_PAYABLE = verified certification/test '
  'trip; expected driver entitlement and commission_pence are explicitly zero; commission '
  'RATE columns remain NULL (no commission applies — not a 0% rate).';

ALTER TABLE public.driver_financial_repair_audit
  DROP CONSTRAINT IF EXISTS driver_financial_repair_audit_event_type_check;

ALTER TABLE public.driver_financial_repair_audit
  ADD CONSTRAINT driver_financial_repair_audit_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'DRIVER_FINANCIAL_REPAIR_PREVIEWED'::text,
    'EXPECTED_STAMP_RESTORED'::text,
    'WALLET_CORRECTION_APPENDED'::text,
    'RECONCILIATION_RECOMPUTED'::text,
    'FALSE_FREEZE_CLEARED'::text,
    'CERTIFICATION_NON_PAYABLE_MARKED'::text,
    'STALE_PAYMENT_SESSION_LINK_CLEARED'::text,
    'FINANCIAL_REPAIR_BLOCKED'::text
  ]));

CREATE OR REPLACE FUNCTION public.admin_apply_certification_non_payable_repair(
  p_driver_id uuid,
  p_trip_id uuid,
  p_admin_user_id uuid,
  p_repair_token uuid,
  p_preview_hash text,
  p_reason text,
  p_idempotency_key text,
  p_expected_owner_trip_id uuid DEFAULT NULL,
  p_stale_payment_session_id uuid DEFAULT NULL,
  p_calculation_version text DEFAULT 'driver_financial_repair_v1'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_k1 int;
  v_k2 int;
  v_trip public.trips%ROWTYPE;
  v_session public.payment_sessions%ROWTYPE;
  v_owned_sessions int := 0;
  v_wallet_rows int := 0;
  v_payout_rows int := 0;
  v_offer_rows int := 0;
  v_prefix text := 'cert-board-exclusivity-';
  v_expected_client_action text;
  v_before jsonb;
  v_after jsonb;
  v_mutation jsonb;
  v_existing_req public.driver_financial_repair_requests%ROWTYPE;
  v_inserted_id uuid;
  v_updated int := 0;
  v_snapshot jsonb;
  v_null_or_zero boolean;
  v_passenger text;
  v_pickup text;
  v_dropoff text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND current_user IS DISTINCT FROM 'service_role'
     AND session_user IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PERMISSION_DENIED');
  END IF;

  IF p_driver_id IS NULL OR p_trip_id IS NULL OR p_admin_user_id IS NULL
     OR p_repair_token IS NULL OR nullif(trim(p_preview_hash), '') IS NULL
     OR nullif(trim(p_idempotency_key), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'INVALID_INPUT');
  END IF;

  IF p_reason IS NULL OR char_length(trim(p_reason)) < 3 OR char_length(trim(p_reason)) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'REASON_INVALID');
  END IF;

  v_k1 := ('x' || substr(md5('driver_financial_repair:' || p_driver_id::text), 1, 8))::bit(32)::int;
  v_k2 := ('x' || substr(md5('driver_financial_repair:' || p_driver_id::text), 9, 8))::bit(32)::int;
  PERFORM pg_advisory_xact_lock(v_k1, v_k2);

  SELECT * INTO v_existing_req
  FROM public.driver_financial_repair_requests
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND AND v_existing_req.status = 'APPLIED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'error_code', 'ALREADY_APPLIED',
      'result', coalesce(v_existing_req.apply_result, jsonb_build_object('already_applied', true))
    );
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'TRIP_NOT_FOUND');
  END IF;

  IF v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'TRIP_DRIVER_MISMATCH');
  END IF;

  IF upper(coalesce(v_trip.financial_outcome, '')) = 'CERTIFICATION_NON_PAYABLE'
     AND v_trip.payment_session_id IS NULL
     AND coalesce(v_trip.driver_net_pence, 0) = 0
     AND coalesce(v_trip.commission_pence, 0) = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'error_code', 'ALREADY_APPLIED',
      'result', jsonb_build_object(
        'already_applied', true,
        'certification_non_payable_marked', true,
        'payment_session_id', null
      )
    );
  END IF;

  IF lower(coalesce(v_trip.booking_source, '')) IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_BOOKING_SOURCE');
  END IF;

  v_expected_client_action := v_prefix || p_trip_id::text;
  IF lower(coalesce(v_trip.client_action_id, '')) IS DISTINCT FROM lower(v_expected_client_action) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_CLIENT_ACTION_ID');
  END IF;

  v_passenger := lower(coalesce(v_trip.passenger_name, ''));
  v_pickup := lower(coalesce(v_trip.pickup_address, ''));
  v_dropoff := lower(coalesce(v_trip.dropoff_address, ''));
  IF v_passenger NOT LIKE '%cert exclusivity%'
     AND v_passenger NOT LIKE '%certification%'
     AND v_passenger NOT LIKE '%cert passenger%' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_MARKERS_MISSING');
  END IF;
  IF v_pickup NOT LIKE '%cert pickup%'
     AND v_pickup NOT LIKE '%certification pickup%'
     AND v_dropoff NOT LIKE '%cert dropoff%'
     AND v_dropoff NOT LIKE '%certification dropoff%' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_MARKERS_MISSING');
  END IF;

  IF lower(coalesce(v_trip.status, '')) IS DISTINCT FROM 'completed' OR v_trip.completed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_LIFECYCLE_INCOMPLETE');
  END IF;

  IF coalesce(v_trip.estimated_fare, 0) <> 0 OR coalesce(v_trip.fare, 0) <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_FARE_NONZERO');
  END IF;

  v_null_or_zero :=
    coalesce(v_trip.gross_fare_pence, 0) = 0
    AND coalesce(v_trip.final_fare_pence, 0) = 0
    AND coalesce(v_trip.quoted_fare_pence, 0) = 0
    AND coalesce(v_trip.commissionable_fare_pence, 0) = 0
    AND coalesce(v_trip.capture_amount_pence, 0) = 0
    AND coalesce(v_trip.tip_pence, 0) = 0
    AND coalesce(v_trip.tip_amount_pence, 0) = 0
    AND coalesce(v_trip.waiting_charge_pence, 0) = 0
    AND coalesce(v_trip.total_waiting_charge_pence, 0) = 0
    AND coalesce(v_trip.pickup_waiting_charge_pence, 0) = 0
    AND coalesce(v_trip.stop_waiting_charge_pence, 0) = 0
    AND coalesce(v_trip.airport_charge_pence, 0) = 0
    AND coalesce(v_trip.platform_promotion_subsidy_pence, 0) = 0
    AND coalesce(v_trip.offer_discount_pence, 0) = 0
    AND coalesce(v_trip.voucher_discount_pence, 0) = 0;

  IF NOT v_null_or_zero THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_MONEY_FIELDS_NONZERO');
  END IF;

  IF (v_trip.driver_net_pence IS NOT NULL AND v_trip.driver_net_pence <> 0)
     OR (v_trip.commission_pence IS NOT NULL AND v_trip.commission_pence <> 0) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_CONFLICTING_EVIDENCE');
  END IF;

  SELECT count(*)::int INTO v_owned_sessions
  FROM public.payment_sessions WHERE trip_id = p_trip_id;
  IF v_owned_sessions <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_OWNED_PAYMENT_SESSION');
  END IF;

  IF p_stale_payment_session_id IS NOT NULL THEN
    IF v_trip.payment_session_id IS DISTINCT FROM p_stale_payment_session_id THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'REPAIR_PREVIEW_STALE');
    END IF;
    IF p_expected_owner_trip_id IS NULL OR p_expected_owner_trip_id = p_trip_id THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_STALE_SESSION_OWNER_UNPROVEN');
    END IF;

    SELECT * INTO v_session
    FROM public.payment_sessions
    WHERE id = p_stale_payment_session_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_STALE_SESSION_OWNER_UNPROVEN');
    END IF;
    IF v_session.trip_id IS DISTINCT FROM p_expected_owner_trip_id THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_STALE_SESSION_OWNER_UNPROVEN');
    END IF;
    IF lower(coalesce(v_session.client_action_id, '')) = lower(v_expected_client_action) THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_STALE_SESSION_OWNER_UNPROVEN');
    END IF;
  ELSIF v_trip.payment_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_STALE_SESSION_OWNER_UNPROVEN');
  END IF;

  SELECT count(*)::int INTO v_wallet_rows
  FROM public.driver_wallet_ledger
  WHERE related_trip_id = p_trip_id
    AND type = ANY (ARRAY[
      'TRIP_EARNING_NET'::text, 'DRIVER_TIP_CREDIT'::text,
      'ADMIN_WALLET_CREDIT'::text, 'ADMIN_WALLET_DEBIT'::text
    ]);
  IF v_wallet_rows <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_WALLET_OR_PAYOUT_EVIDENCE');
  END IF;

  SELECT count(*)::int INTO v_payout_rows
  FROM public.payout_items WHERE trip_id = p_trip_id;
  IF v_payout_rows <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_WALLET_OR_PAYOUT_EVIDENCE');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.driver_payout_reservations
    WHERE driver_id = p_driver_id
      AND upper(coalesce(status, '')) = ANY (ARRAY['ACTIVE','RESERVED','HELD','OPEN'])
    LIMIT 1
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_WALLET_OR_PAYOUT_EVIDENCE');
  END IF;

  SELECT count(*)::int INTO v_offer_rows
  FROM public.ride_offers
  WHERE trip_id = p_trip_id AND lower(coalesce(status, '')) = 'accepted';
  IF v_offer_rows <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CERT_RIDE_OFFER_OR_ENTITLEMENT');
  END IF;

  v_before := jsonb_build_object(
    'payment_session_id', v_trip.payment_session_id,
    'financial_outcome', v_trip.financial_outcome,
    'driver_net_pence', v_trip.driver_net_pence,
    'driver_net_before_tip_pence', v_trip.driver_net_before_tip_pence,
    'commission_pence', v_trip.commission_pence,
    'tip_pence', v_trip.tip_pence,
    'tip_amount_pence', v_trip.tip_amount_pence,
    'airport_charge_pence', v_trip.airport_charge_pence,
    'final_fare_pence', v_trip.final_fare_pence,
    'gross_fare_pence', v_trip.gross_fare_pence,
    'commissionable_fare_pence', v_trip.commissionable_fare_pence,
    'invoice_payment_classification', v_trip.invoice_payment_classification,
    'commission_pct', v_trip.commission_pct,
    'accepted_commission_percent', v_trip.accepted_commission_percent,
    'driver_tier_commission_percent', v_trip.driver_tier_commission_percent
  );

  v_after := jsonb_build_object(
    'payment_session_id', null,
    'financial_outcome', 'CERTIFICATION_NON_PAYABLE',
    'driver_net_pence', 0,
    'driver_net_before_tip_pence', 0,
    'commission_pence', 0,
    'tip_pence', 0,
    'tip_amount_pence', 0,
    'airport_charge_pence', 0,
    'final_fare_pence', 0,
    'gross_fare_pence', 0,
    'commissionable_fare_pence', 0,
    'invoice_payment_classification', 'CERTIFICATION_NON_PAYABLE',
    'commission_pct', v_trip.commission_pct,
    'accepted_commission_percent', v_trip.accepted_commission_percent,
    'driver_tier_commission_percent', v_trip.driver_tier_commission_percent
  );

  v_mutation := jsonb_build_object(
    'fields', jsonb_build_array(
      jsonb_build_object('field','payment_session_id','before',v_trip.payment_session_id,'after',null,
        'why','Clear stale trip-side FK only; payment_sessions row untouched'),
      jsonb_build_object('field','financial_outcome','before',v_trip.financial_outcome,
        'after','CERTIFICATION_NON_PAYABLE','why','Canonical non-payable outcome'),
      jsonb_build_object('field','driver_net_pence','before',v_trip.driver_net_pence,'after',0,
        'why','FR explicit zero entitlement'),
      jsonb_build_object('field','commission_pence','before',v_trip.commission_pence,'after',0,
        'why','FR explicit zero commission amount; rate stays NULL'),
      jsonb_build_object('field','final_fare_pence','before',v_trip.final_fare_pence,'after',0,'why','FR zero fare'),
      jsonb_build_object('field','gross_fare_pence','before',v_trip.gross_fare_pence,'after',0,'why','FR zero gross'),
      jsonb_build_object('field','commissionable_fare_pence','before',v_trip.commissionable_fare_pence,'after',0,'why','FR zero commissionable'),
      jsonb_build_object('field','tip_pence','before',v_trip.tip_pence,'after',0,'why','FR zero tip'),
      jsonb_build_object('field','tip_amount_pence','before',v_trip.tip_amount_pence,'after',0,'why','FR zero tip'),
      jsonb_build_object('field','airport_charge_pence','before',v_trip.airport_charge_pence,'after',0,'why','FR zero airport'),
      jsonb_build_object('field','driver_net_before_tip_pence','before',v_trip.driver_net_before_tip_pence,'after',0,'why','FR zero net-before-tip'),
      jsonb_build_object('field','invoice_payment_classification','before',v_trip.invoice_payment_classification,
        'after','CERTIFICATION_NON_PAYABLE','why','Canonical existing invoice classification SSOT')
    )
  );

  UPDATE public.trips
  SET
    payment_session_id = NULL,
    financial_outcome = 'CERTIFICATION_NON_PAYABLE',
    driver_net_pence = 0,
    driver_net_before_tip_pence = 0,
    commission_pence = 0,
    tip_pence = 0,
    tip_amount_pence = 0,
    airport_charge_pence = 0,
    final_fare_pence = 0,
    gross_fare_pence = 0,
    commissionable_fare_pence = 0,
    invoice_payment_classification = 'CERTIFICATION_NON_PAYABLE',
    fare_snapshot_json = coalesce(fare_snapshot_json, '{}'::jsonb) || jsonb_build_object(
      'financial_outcome', 'CERTIFICATION_NON_PAYABLE',
      'driver_net_pence', 0,
      'commission_pence', 0,
      'final_fare_pence', 0,
      'gross_fare_pence', 0,
      'commissionable_fare_pence', 0,
      'tip_pence', 0,
      'airport_charge_pence', 0,
      'commission_applies', false,
      'settlement_formula_version', 'certification_non_payable_v1',
      'repair_token', p_repair_token,
      'repair_calculation_version', p_calculation_version
    )
  WHERE id = p_trip_id
    AND (
      p_stale_payment_session_id IS NULL
      OR payment_session_id = p_stale_payment_session_id
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'REPAIR_PREVIEW_STALE');
  END IF;

  INSERT INTO public.driver_financial_repair_requests (
    repair_token, driver_id, trip_id, preview_hash, classification, preview_payload,
    status, calculation_version, created_by_admin_id, applied_by_admin_id,
    apply_reason, apply_result, idempotency_key, applied_at
  ) VALUES (
    p_repair_token, p_driver_id, p_trip_id, p_preview_hash, 'CERTIFICATION_NON_PAYABLE',
    jsonb_build_object('mutation', v_mutation, 'before', v_before, 'after', v_after),
    'APPLIED', p_calculation_version, p_admin_user_id, p_admin_user_id,
    trim(p_reason),
    jsonb_build_object(
      'certification_non_payable_marked', true,
      'stale_payment_session_link_cleared', p_stale_payment_session_id IS NOT NULL,
      'cleared_payment_session_id', p_stale_payment_session_id,
      'owner_trip_id', p_expected_owner_trip_id,
      'proven_wallet_delta_pence', 0,
      'actual_wallet_delta_pence', 0,
      'wallet_money_changed', false,
      'provider_action', 'none',
      'payout_action', 'none',
      'commission_rate_unchanged_null', true,
      'classification', 'CERTIFICATION_NON_PAYABLE'
    ),
    p_idempotency_key,
    now()
  )
  ON CONFLICT (idempotency_key) WHERE (idempotency_key IS NOT NULL)
  DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NULL THEN
    SELECT * INTO v_existing_req
    FROM public.driver_financial_repair_requests
    WHERE idempotency_key = p_idempotency_key;
    IF FOUND AND v_existing_req.status = 'APPLIED' THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'error_code', 'ALREADY_APPLIED',
        'result', coalesce(v_existing_req.apply_result, jsonb_build_object('already_applied', true))
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code', 'APPLY_PERSIST_FAILED');
  END IF;

  INSERT INTO public.driver_financial_repair_audit (
    event_type, repair_token, idempotency_key, preview_hash, driver_id, trip_id,
    admin_user_id, reason, calculation_version, before_state, after_state, details
  ) VALUES (
    'CERTIFICATION_NON_PAYABLE_MARKED', p_repair_token, p_idempotency_key, p_preview_hash,
    p_driver_id, p_trip_id, p_admin_user_id, trim(p_reason), p_calculation_version,
    v_before, v_after,
    jsonb_build_object('mutation', v_mutation, 'provider_action', 'none', 'payout_action', 'none',
      'wallet_delta_pence', 0)
  );

  IF p_stale_payment_session_id IS NOT NULL THEN
    INSERT INTO public.driver_financial_repair_audit (
      event_type, repair_token, idempotency_key, preview_hash, driver_id, trip_id,
      admin_user_id, reason, calculation_version, before_state, after_state, details
    ) VALUES (
      'STALE_PAYMENT_SESSION_LINK_CLEARED', p_repair_token, p_idempotency_key, p_preview_hash,
      p_driver_id, p_trip_id, p_admin_user_id, trim(p_reason), p_calculation_version,
      jsonb_build_object('payment_session_id', p_stale_payment_session_id, 'owner_trip_id', p_expected_owner_trip_id),
      jsonb_build_object('payment_session_id', null),
      jsonb_build_object('payment_sessions_row_unchanged', true, 'owner_trip_unchanged', true)
    );
  END IF;

  v_snapshot := jsonb_build_object(
    'trip_id', p_trip_id,
    'financial_outcome', 'CERTIFICATION_NON_PAYABLE',
    'expected_entitlement_pence', 0,
    'expected_stamp_status', 'OK',
    'entitlement_source', 'certification_non_payable',
    'commission_pct', v_trip.commission_pct,
    'commission_applies', false,
    'payment_session_id', null,
    'owned_payment_session_count', 0
  );

  INSERT INTO public.driver_financial_repair_audit (
    event_type, repair_token, idempotency_key, preview_hash, driver_id, trip_id,
    admin_user_id, reason, calculation_version, after_state, details
  ) VALUES (
    'RECONCILIATION_RECOMPUTED', p_repair_token, p_idempotency_key, p_preview_hash,
    p_driver_id, p_trip_id, p_admin_user_id, trim(p_reason), p_calculation_version,
    jsonb_build_object('recompute', v_snapshot),
    jsonb_build_object('scope', 'trip', 'clears_expected_stamp_missing_for_trip', true)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'result', jsonb_build_object(
      'certification_non_payable_marked', true,
      'stale_payment_session_link_cleared', p_stale_payment_session_id IS NOT NULL,
      'cleared_payment_session_id', p_stale_payment_session_id,
      'owner_trip_id', p_expected_owner_trip_id,
      'proven_wallet_delta_pence', 0,
      'actual_wallet_delta_pence', 0,
      'wallet_money_changed', false,
      'provider_action', 'none',
      'payout_action', 'none',
      'commission_rate_unchanged_null', v_trip.commission_pct IS NULL,
      'before', v_before,
      'after', v_after,
      'mutation', v_mutation,
      'recompute', v_snapshot,
      'classification', 'CERTIFICATION_NON_PAYABLE'
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, text
) TO service_role;

COMMIT;
