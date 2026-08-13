-- DRIVER_COLLECTED_COMMISSION_WALLET completion isolation.
-- 1) Prefer trip financial-model snapshot when settling commission.
-- 2) Idempotent COMMISSION_DEDUCTION when trip becomes completed.
-- 3) Suppress Platform-Collected driver_wallet_ledger earnings for CW trips.

CREATE OR REPLACE FUNCTION public.convert_driver_commission_wallet_on_trip_complete(p_driver_id uuid, p_trip_id uuid, p_commission_minor integer DEFAULT NULL::integer, p_commissionable_fare_minor integer DEFAULT NULL::integer, p_commission_rate_bps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_existing_deduction_id uuid;
  v_fare_minor integer;
  v_airport integer;
  v_pass_through integer;
  v_commissionable integer;
  v_rate_bps integer;
  v_pct numeric;
  v_earned integer;
  v_parts record;
  v_promo integer;
  v_purchased integer;
  v_from_promo integer;
  v_from_purchased integer;
  v_currency text;
  v_deduction_idempotency text;
  v_deduction_ledger_id uuid;
  v_trip_code text;
  v_balance_before integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND', 'error', 'Trip not found');
  END IF;

  -- Prefer persisted trip payment model; fall back to current SA only when snapshot absent.
  IF NOT public.trip_row_is_commission_wallet_driver_collected(v_trip) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'WALLET_GATE_OFF');
  END IF;

  IF v_trip.service_area_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_AREA_MISSING', 'error', 'Trip has no service area');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_AREA_NOT_FOUND', 'error', 'Service area not found');
  END IF;

  SELECT id INTO v_existing_deduction_id
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id
    AND entry_type = 'COMMISSION_DEDUCTION'
  LIMIT 1;

  IF v_existing_deduction_id IS NOT NULL THEN
    UPDATE public.driver_commission_wallet_reserves
    SET status = 'legacy_reservation_voided', updated_at = now()
    WHERE driver_id = p_driver_id
      AND trip_id = p_trip_id
      AND status = 'active';

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_existing_deduction_id,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  UPDATE public.driver_commission_wallet_reserves
  SET
    status = 'legacy_reservation_voided',
    updated_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_void_reason', 'voided_on_completion_no_pretrip_reserve',
      'voided_at', now()
    )
  WHERE driver_id = p_driver_id
    AND trip_id = p_trip_id
    AND status = 'active';

  IF p_commission_minor IS NOT NULL THEN
    v_earned := GREATEST(0, p_commission_minor);
  ELSE
    v_fare_minor := GREATEST(
      0,
      COALESCE(
        NULLIF(v_trip.final_customer_fare_pence, 0),
        NULLIF(v_trip.final_fare_pence, 0),
        public.trip_commission_reserve_fare_minor(v_trip)
      )
    );
    v_airport := GREATEST(0, COALESCE(v_trip.airport_charge_pence, 0));
    v_pass_through := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));
    v_commissionable := GREATEST(
      0,
      COALESCE(NULLIF(p_commissionable_fare_minor, 0), v_fare_minor - v_airport - v_pass_through)
    );
    v_pct := COALESCE(
      NULLIF(v_trip.driver_tier_commission_percent, 0),
      public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
      0
    );
    v_rate_bps := GREATEST(
      0,
      COALESCE(
        NULLIF(p_commission_rate_bps, 0),
        NULLIF(v_trip.snapshotted_commission_rate_bps, 0),
        ROUND(v_pct * 100)::integer
      )
    );
    v_earned := public.required_commission_reserve_minor(v_commissionable, v_rate_bps);
  END IF;

  IF v_earned <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'ZERO_COMMISSION',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  SELECT * INTO v_parts
  FROM public.driver_commission_wallet_balance_parts(p_driver_id, v_trip.service_area_id);

  v_balance_before := COALESCE(v_parts.usable_commission_balance_minor, 0);
  v_promo := COALESCE(v_parts.promotional_balance_minor, 0);
  v_purchased := COALESCE(v_parts.purchased_balance_minor, 0);

  v_from_promo := LEAST(v_earned, GREATEST(0, v_promo));
  v_from_purchased := v_earned - v_from_promo;

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    NULLIF(v_trip.snapshotted_commission_currency, ''),
    'USD'
  ));

  v_trip_code := NULLIF(btrim(COALESCE(v_trip.trip_code, '')), '');
  v_deduction_idempotency := left('cw_deduction_' || p_trip_id::text, 180);

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
    trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
  ) VALUES (
    p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_DEDUCTION', v_earned, 'debit', p_trip_id,
    'Completed-trip commission deduction',
    v_from_promo, v_from_purchased, v_deduction_idempotency,
    jsonb_build_object(
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION',
      'phase', 'no_pretrip_reserve',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'trip_id', p_trip_id,
      'public_trip_id', v_trip_code,
      'trip_code', v_trip_code,
      'driver_id', p_driver_id,
      'service_area_id', v_trip.service_area_id,
      'final_fare_minor', COALESCE(v_fare_minor, v_commissionable),
      'commissionable_fare_minor', COALESCE(p_commissionable_fare_minor, v_commissionable),
      'commission_rate_bps', COALESCE(p_commission_rate_bps, v_rate_bps),
      'commission_amount_minor', v_earned,
      'currency', v_currency,
      'completion_at', now(),
      'balance_before_minor', v_balance_before,
      'balance_after_minor', v_balance_before - v_earned,
      'allows_negative', true
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_deduction_ledger_id;

  IF v_deduction_ledger_id IS NULL THEN
    SELECT id INTO v_deduction_ledger_id
    FROM public.driver_commission_wallet_ledger
    WHERE idempotency_key = v_deduction_idempotency;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  UPDATE public.trips
  SET
    financial_model = COALESCE(financial_model, 'DRIVER_COLLECTED_COMMISSION_WALLET'),
    commission_wallet_enabled = COALESCE(commission_wallet_enabled, true),
    snapshotted_commission_rate_bps = COALESCE(
      NULLIF(snapshotted_commission_rate_bps, 0),
      COALESCE(p_commission_rate_bps, v_rate_bps)
    ),
    snapshotted_commission_currency = COALESCE(
      NULLIF(snapshotted_commission_currency, ''),
      v_currency
    ),
    updated_at = now()
  WHERE id = p_trip_id
    AND public.is_commission_wallet_workflow_enabled(service_area_id);

  RETURN jsonb_build_object(
    'ok', true,
    'ledger_entry_id', v_deduction_ledger_id,
    'amount_minor', v_earned,
    'commission_earned_minor', v_earned,
    'shortfall_minor', GREATEST(0, v_earned - GREATEST(v_balance_before, 0)),
    'forced_overdraft', v_balance_before < v_earned,
    'promotional_portion_minor', v_from_promo,
    'purchased_portion_minor', v_from_purchased,
    'balance_before_minor', v_balance_before,
    'balance_after_minor', v_balance_before - v_earned,
    'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
    'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, amount_minor INTO v_deduction_ledger_id, v_earned
    FROM public.driver_commission_wallet_ledger
    WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_DEDUCTION'
    LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
END;
$function$;

COMMENT ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) IS
  'Idempotent CW commission deduction. Trip snapshot preferred over current SA config.';

CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_complete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  IF NOT public.trip_row_is_commission_wallet_driver_collected(NEW) THEN
    RETURN NEW;
  END IF;

  v_driver_id := COALESCE(NEW.driver_id, NEW.confirmed_driver_id);
  IF v_driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.convert_driver_commission_wallet_on_trip_complete(
    v_driver_id,
    NEW.id,
    NEW.commission_pence,
    NEW.commissionable_fare_pence,
    NEW.snapshotted_commission_rate_bps
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[trg_commission_wallet_on_trip_complete] trip %: % (%)',
    NEW.id, SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_wallet_on_trip_complete ON public.trips;
CREATE TRIGGER trg_commission_wallet_on_trip_complete
  AFTER INSERT OR UPDATE OF status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_on_trip_complete();

CREATE OR REPLACE FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
BEGIN
  IF NEW.related_trip_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = NEW.related_trip_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NOT public.trip_row_is_commission_wallet_driver_collected(v_trip) THEN
    RETURN NEW;
  END IF;

  IF UPPER(COALESCE(NEW.type, '')) IN (
    'TRIP_EARNING_NET',
    'CASH_TRIP_EARNING',
    'CASH_COMMISSION_DEBT',
    'PLATFORM_COMMISSION',
    'DRIVER_TIP_CREDIT'
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_platform_wallet_ledger_on_cw_trip ON public.driver_wallet_ledger;
CREATE TRIGGER trg_prevent_platform_wallet_ledger_on_cw_trip
  BEFORE INSERT ON public.driver_wallet_ledger
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_platform_wallet_ledger_on_cw_trip();
