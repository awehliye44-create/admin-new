-- P0 Commission Wallet gap-close pass 5:
-- 1) Active reserve recalculates when required amount changes (preset/fare update)
-- 2) Trip fare updates on assigned CW trips re-run reserve adjust
-- 3) Lock trip financial snapshot fields once set (no silent SA-edit rewrite)

CREATE OR REPLACE FUNCTION public.reserve_driver_commission_wallet(
  p_driver_id uuid,
  p_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_existing public.driver_commission_wallet_reserves%ROWTYPE;
  v_has_existing boolean := false;
  v_fare_minor integer;
  v_rate_bps integer;
  v_pct numeric;
  v_required integer;
  v_usable integer;
  v_currency text;
  v_idempotency text;
  v_ledger_id uuid;
  v_reserve_id uuid;
  v_attempt integer;
  v_delta integer;
  v_old_amount integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND', 'error', 'Trip not found');
  END IF;

  IF v_trip.service_area_id IS NULL
     OR NOT public.is_commission_wallet_reserve_enabled(v_trip.service_area_id) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'WALLET_GATE_OFF');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_AREA_NOT_FOUND', 'error', 'Service area not found');
  END IF;

  SELECT * INTO v_existing
  FROM public.driver_commission_wallet_reserves
  WHERE driver_id = p_driver_id AND trip_id = p_trip_id
  FOR UPDATE;
  v_has_existing := FOUND;

  IF v_has_existing AND v_existing.status = 'converted_to_deduction' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'RESERVE_CONVERTED',
      'error', 'Reserve already converted to deduction'
    );
  END IF;

  v_fare_minor := public.trip_commission_reserve_fare_minor(v_trip);
  v_pct := COALESCE(
    NULLIF(v_trip.driver_tier_commission_percent, 0),
    public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
    0
  );
  v_rate_bps := GREATEST(
    0,
    COALESCE(NULLIF(v_trip.snapshotted_commission_rate_bps, 0), ROUND(v_pct * 100)::integer)
  );
  v_required := public.required_commission_reserve_minor(v_fare_minor, v_rate_bps);

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    'USD'
  ));

  -- Active reserve: recalculate if required amount changed (preset / fare update).
  IF v_has_existing AND v_existing.status = 'active' THEN
    v_old_amount := COALESCE(v_existing.reserved_amount_minor, 0);
    v_reserve_id := v_existing.id;

    IF v_required = v_old_amount THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'code', 'ALREADY_RESERVED',
        'reserve_id', v_reserve_id,
        'amount_minor', v_old_amount
      );
    END IF;

    IF v_required <= 0 THEN
      RETURN public.release_driver_commission_wallet(
        p_driver_id, p_trip_id, 'fare_zero_after_recalc'
      );
    END IF;

    v_delta := v_required - v_old_amount;
    v_usable := public.driver_commission_wallet_usable_balance_minor(
      p_driver_id, v_trip.service_area_id
    );

    IF v_delta > 0 THEN
      -- usable already excludes current reserve; need delta available.
      IF v_usable < v_delta THEN
        RETURN jsonb_build_object(
          'ok', false,
          'code', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
          'error', format(
            'Usable balance %s < additional reserve %s (required %s, current %s)',
            v_usable, v_delta, v_required, v_old_amount
          ),
          'usable_commission_balance_minor', v_usable,
          'required_reserve_minor', v_required,
          'current_reserve_minor', v_old_amount,
          'fare_minor', v_fare_minor,
          'commission_rate_bps', v_rate_bps
        );
      END IF;

      SELECT COUNT(*)::integer + 1 INTO v_attempt
      FROM public.driver_commission_wallet_ledger
      WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_RESERVE';

      v_idempotency := left(
        'cw_reserve_adj_up_' || p_driver_id::text || '_' || p_trip_id::text
          || '_' || v_old_amount::text || '_' || v_required::text || '_' || v_attempt::text,
        180
      );

      INSERT INTO public.driver_commission_wallet_ledger (
        driver_id, service_area_id, region_id, currency, entry_type, amount_minor,
        direction, trip_id, reason, promotional_portion_minor, purchased_portion_minor,
        idempotency_key, metadata
      ) VALUES (
        p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
        'COMMISSION_RESERVE', v_delta, 'debit', p_trip_id,
        'Phase 6 reserve increase after fare/preset recalc',
        0, 0, v_idempotency,
        jsonb_build_object(
          'phase', 'phase6_reserve_recalc',
          'direction', 'increase',
          'old_amount_minor', v_old_amount,
          'new_amount_minor', v_required,
          'fare_minor', v_fare_minor,
          'commission_rate_bps', v_rate_bps
        )
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id INTO v_ledger_id;

    ELSIF v_delta < 0 THEN
      SELECT COUNT(*)::integer + 1 INTO v_attempt
      FROM public.driver_commission_wallet_ledger
      WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_RESERVE_RELEASE';

      v_idempotency := left(
        'cw_reserve_adj_down_' || p_driver_id::text || '_' || p_trip_id::text
          || '_' || v_old_amount::text || '_' || v_required::text || '_' || v_attempt::text,
        180
      );

      INSERT INTO public.driver_commission_wallet_ledger (
        driver_id, service_area_id, region_id, currency, entry_type, amount_minor,
        direction, trip_id, reason, promotional_portion_minor, purchased_portion_minor,
        idempotency_key, metadata
      ) VALUES (
        p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
        'COMMISSION_RESERVE_RELEASE', ABS(v_delta), 'credit', p_trip_id,
        'Phase 6 reserve decrease after fare/preset recalc',
        0, 0, v_idempotency,
        jsonb_build_object(
          'phase', 'phase6_reserve_recalc',
          'direction', 'decrease',
          'old_amount_minor', v_old_amount,
          'new_amount_minor', v_required,
          'fare_minor', v_fare_minor,
          'commission_rate_bps', v_rate_bps
        )
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id INTO v_ledger_id;
    END IF;

    UPDATE public.driver_commission_wallet_reserves
    SET
      reserved_amount_minor = v_required,
      currency = v_currency,
      updated_at = now()
    WHERE id = v_reserve_id;

    UPDATE public.trips
    SET
      financial_model = COALESCE(financial_model, 'DRIVER_COLLECTED_COMMISSION_WALLET'),
      commission_wallet_enabled = COALESCE(commission_wallet_enabled, true),
      snapshotted_commission_rate_bps = COALESCE(NULLIF(snapshotted_commission_rate_bps, 0), v_rate_bps),
      updated_at = now()
    WHERE id = p_trip_id
      AND public.is_commission_wallet_reserve_enabled(service_area_id);

    RETURN jsonb_build_object(
      'ok', true,
      'adjusted', true,
      'code', 'RESERVE_ADJUSTED',
      'reserve_id', v_reserve_id,
      'ledger_entry_id', v_ledger_id,
      'amount_minor', v_required,
      'old_amount_minor', v_old_amount,
      'fare_minor', v_fare_minor,
      'commission_rate_bps', v_rate_bps
    );
  END IF;

  -- No active reserve: create new (same as Phase 6).
  IF v_required <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'ZERO_RESERVE',
      'fare_minor', v_fare_minor,
      'commission_rate_bps', v_rate_bps
    );
  END IF;

  v_usable := public.driver_commission_wallet_usable_balance_minor(p_driver_id, v_trip.service_area_id);
  IF v_usable < v_required THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
      'error', format('Usable balance %s < required reserve %s', v_usable, v_required),
      'usable_commission_balance_minor', v_usable,
      'required_reserve_minor', v_required,
      'fare_minor', v_fare_minor,
      'commission_rate_bps', v_rate_bps
    );
  END IF;

  SELECT COUNT(*)::integer + 1 INTO v_attempt
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id
    AND entry_type = 'COMMISSION_RESERVE';

  v_idempotency := left(
    'cw_reserve_' || p_driver_id::text || '_' || p_trip_id::text || '_' || v_attempt::text,
    180
  );

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor,
    direction, trip_id, reason, promotional_portion_minor, purchased_portion_minor,
    idempotency_key, metadata
  ) VALUES (
    p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_RESERVE', v_required, 'debit', p_trip_id,
    'Phase 6 accept-time commission reserve',
    0, 0, v_idempotency,
    jsonb_build_object(
      'phase', 'phase6_reserve',
      'fare_minor', v_fare_minor,
      'commission_rate_bps', v_rate_bps,
      'attempt', v_attempt
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    SELECT id INTO v_ledger_id
    FROM public.driver_commission_wallet_ledger
    WHERE idempotency_key = v_idempotency;
  END IF;

  INSERT INTO public.driver_commission_wallet_reserves (
    driver_id, service_area_id, trip_id, currency, reserved_amount_minor,
    status, reserve_ledger_entry_id
  ) VALUES (
    p_driver_id, v_trip.service_area_id, p_trip_id, v_currency, v_required,
    'active', v_ledger_id
  )
  ON CONFLICT (driver_id, trip_id) DO UPDATE
  SET
    status = 'active',
    reserved_amount_minor = EXCLUDED.reserved_amount_minor,
    currency = EXCLUDED.currency,
    reserve_ledger_entry_id = EXCLUDED.reserve_ledger_entry_id,
    release_ledger_entry_id = NULL,
    updated_at = now()
  RETURNING id INTO v_reserve_id;

  UPDATE public.trips
  SET
    financial_model = COALESCE(financial_model, 'DRIVER_COLLECTED_COMMISSION_WALLET'),
    commission_wallet_enabled = COALESCE(commission_wallet_enabled, true),
    snapshotted_commission_rate_bps = COALESCE(NULLIF(snapshotted_commission_rate_bps, 0), v_rate_bps),
    updated_at = now()
  WHERE id = p_trip_id
    AND public.is_commission_wallet_reserve_enabled(service_area_id);

  RETURN jsonb_build_object(
    'ok', true,
    'reserve_id', v_reserve_id,
    'ledger_entry_id', v_ledger_id,
    'amount_minor', v_required,
    'usable_after_minor', v_usable - v_required,
    'fare_minor', v_fare_minor,
    'commission_rate_bps', v_rate_bps
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, reserved_amount_minor INTO v_reserve_id, v_required
    FROM public.driver_commission_wallet_reserves
    WHERE driver_id = p_driver_id AND trip_id = p_trip_id AND status = 'active';
    IF v_reserve_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'code', 'ALREADY_RESERVED',
        'reserve_id', v_reserve_id,
        'amount_minor', v_required
      );
    END IF;
    RAISE;
END;
$$;

COMMENT ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) IS
  'Phase 6+P0: accept-time CW reserve; recalculates active reserve when required amount changes.';

-- When trip fare fields change after assign, recalculate active CW reserve.
CREATE OR REPLACE FUNCTION public.trg_trips_cw_reserve_recalc_on_fare()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.service_area_id IS NULL
     OR NOT public.is_commission_wallet_reserve_enabled(NEW.service_area_id) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.final_customer_fare_pence IS NOT DISTINCT FROM NEW.final_customer_fare_pence
     AND OLD.final_fare_pence IS NOT DISTINCT FROM NEW.final_fare_pence
     AND OLD.accepted_driver_offer_fare_pence IS NOT DISTINCT FROM NEW.accepted_driver_offer_fare_pence
     AND OLD.estimated_total_pence IS NOT DISTINCT FROM NEW.estimated_total_pence
     AND OLD.estimated_fare IS NOT DISTINCT FROM NEW.estimated_fare
  THEN
    RETURN NEW;
  END IF;

  v_result := public.reserve_driver_commission_wallet(NEW.driver_id, NEW.id);
  IF (v_result->>'ok') = 'false'
     AND COALESCE(v_result->>'code', '') = 'INSUFFICIENT_COMMISSION_WALLET_BALANCE'
  THEN
    RAISE EXCEPTION 'INSUFFICIENT_COMMISSION_WALLET_BALANCE: %',
      COALESCE(v_result->>'error', 'insufficient commission wallet for fare change')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trips_cw_reserve_recalc_on_fare ON public.trips;
CREATE TRIGGER trg_trips_cw_reserve_recalc_on_fare
  AFTER UPDATE OF
    final_customer_fare_pence,
    final_fare_pence,
    accepted_driver_offer_fare_pence,
    estimated_total_pence,
    estimated_fare
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_trips_cw_reserve_recalc_on_fare();

-- Lock trip CW financial snapshot once set (NULL→value allowed once).
CREATE OR REPLACE FUNCTION public.enforce_trip_commission_wallet_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF OLD.financial_model IS NOT NULL
     AND NEW.financial_model IS DISTINCT FROM OLD.financial_model THEN
    RAISE EXCEPTION 'TRIP_CW_SNAPSHOT_IMMUTABLE: financial_model'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.payment_collection_model IS NOT NULL
     AND NEW.payment_collection_model IS DISTINCT FROM OLD.payment_collection_model THEN
    RAISE EXCEPTION 'TRIP_CW_SNAPSHOT_IMMUTABLE: payment_collection_model'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.commission_wallet_enabled IS NOT NULL
     AND NEW.commission_wallet_enabled IS DISTINCT FROM OLD.commission_wallet_enabled THEN
    RAISE EXCEPTION 'TRIP_CW_SNAPSHOT_IMMUTABLE: commission_wallet_enabled'
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(OLD.snapshotted_commission_rate_bps, 0) > 0
     AND NEW.snapshotted_commission_rate_bps IS DISTINCT FROM OLD.snapshotted_commission_rate_bps THEN
    RAISE EXCEPTION 'TRIP_CW_SNAPSHOT_IMMUTABLE: snapshotted_commission_rate_bps'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.snapshotted_commission_currency IS NOT NULL
     AND NULLIF(btrim(OLD.snapshotted_commission_currency), '') IS NOT NULL
     AND NEW.snapshotted_commission_currency IS DISTINCT FROM OLD.snapshotted_commission_currency THEN
    RAISE EXCEPTION 'TRIP_CW_SNAPSHOT_IMMUTABLE: snapshotted_commission_currency'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_trip_cw_snapshot_immutable ON public.trips;
CREATE TRIGGER trg_enforce_trip_cw_snapshot_immutable
  BEFORE UPDATE OF
    financial_model,
    payment_collection_model,
    commission_wallet_enabled,
    snapshotted_commission_rate_bps,
    snapshotted_commission_currency
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trip_commission_wallet_snapshot_immutable();
