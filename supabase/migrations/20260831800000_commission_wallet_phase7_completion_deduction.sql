-- Phase 7: Completed-trip commission deduction + reserve → converted_to_deduction.
-- Gate: is_commission_wallet_workflow_enabled (not reserve-only).
-- Never writes driver_wallet_ledger. PLATFORM_COLLECTED paths unchanged (RPC no-ops).

CREATE OR REPLACE FUNCTION public.driver_commission_wallet_balance_parts(
  p_driver_id uuid,
  p_service_area_id uuid
)
RETURNS TABLE (
  purchased_balance_minor integer,
  promotional_balance_minor integer,
  reserved_balance_minor integer,
  usable_commission_balance_minor integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_purchased integer := 0;
  v_promotional integer := 0;
  v_reserved integer := 0;
  v_amount integer;
  v_promo_part integer;
  v_purchased_part integer;
  v_need integer;
  v_from_promo integer;
BEGIN
  IF p_driver_id IS NULL OR p_service_area_id IS NULL THEN
    purchased_balance_minor := 0;
    promotional_balance_minor := 0;
    reserved_balance_minor := 0;
    usable_commission_balance_minor := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      entry_type::text AS entry_type,
      amount_minor,
      direction,
      COALESCE(promotional_portion_minor, 0) AS promotional_portion_minor,
      COALESCE(purchased_portion_minor, 0) AS purchased_portion_minor
    FROM public.driver_commission_wallet_ledger
    WHERE driver_id = p_driver_id
      AND service_area_id = p_service_area_id
    ORDER BY created_at ASC, id ASC
  LOOP
    v_amount := GREATEST(0, COALESCE(r.amount_minor, 0));

    IF r.entry_type = 'TOP_UP_CREDIT' THEN
      v_purchased := v_purchased + v_amount;
    ELSIF r.entry_type = 'TOP_UP_REVERSAL' THEN
      v_purchased := v_purchased - v_amount;
    ELSIF r.entry_type IN ('WELCOME_CREDIT', 'PROMOTIONAL_CREDIT', 'ADMIN_CREDIT') THEN
      IF r.direction = 'debit' THEN
        v_promotional := v_promotional - v_amount;
      ELSE
        v_promotional := v_promotional + v_amount;
      END IF;
    ELSIF r.entry_type = 'ADMIN_CORRECTION' THEN
      IF r.direction = 'debit' THEN
        v_promotional := v_promotional - v_amount;
      ELSE
        v_promotional := v_promotional + v_amount;
      END IF;
    ELSIF r.entry_type = 'COMMISSION_RESERVE' THEN
      v_reserved := v_reserved + v_amount;
    ELSIF r.entry_type = 'COMMISSION_RESERVE_RELEASE' THEN
      v_reserved := v_reserved - v_amount;
    ELSIF r.entry_type = 'COMMISSION_DEDUCTION' THEN
      v_promo_part := GREATEST(0, r.promotional_portion_minor);
      v_purchased_part := GREATEST(0, r.purchased_portion_minor);
      IF v_promo_part + v_purchased_part > 0 THEN
        v_promotional := v_promotional - v_promo_part;
        v_purchased := v_purchased - v_purchased_part;
      ELSE
        v_need := v_amount;
        v_from_promo := LEAST(v_need, GREATEST(0, v_promotional));
        v_promotional := v_promotional - v_from_promo;
        v_purchased := v_purchased - (v_need - v_from_promo);
      END IF;
    ELSIF r.entry_type = 'COMMISSION_DEDUCTION_REVERSAL' THEN
      v_promo_part := GREATEST(0, r.promotional_portion_minor);
      v_purchased_part := GREATEST(0, r.purchased_portion_minor);
      IF v_promo_part + v_purchased_part > 0 THEN
        v_promotional := v_promotional + v_promo_part;
        v_purchased := v_purchased + v_purchased_part;
      ELSE
        v_promotional := v_promotional + v_amount;
      END IF;
    END IF;
  END LOOP;

  purchased_balance_minor := GREATEST(0, v_purchased);
  promotional_balance_minor := GREATEST(0, v_promotional);
  reserved_balance_minor := GREATEST(0, v_reserved);
  usable_commission_balance_minor := GREATEST(
    0,
    purchased_balance_minor + promotional_balance_minor - reserved_balance_minor
  );
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) IS
  'Phase 7: purchased / promotional / reserved / usable from immutable CW ledger.';

CREATE OR REPLACE FUNCTION public.convert_driver_commission_wallet_on_trip_complete(
  p_driver_id uuid,
  p_trip_id uuid,
  p_commission_minor integer DEFAULT NULL,
  p_commissionable_fare_minor integer DEFAULT NULL,
  p_commission_rate_bps integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_reserve public.driver_commission_wallet_reserves%ROWTYPE;
  v_has_reserve boolean := false;
  v_existing_deduction_id uuid;
  v_fare_minor integer;
  v_airport integer;
  v_pass_through integer;
  v_commissionable integer;
  v_rate_bps integer;
  v_pct numeric;
  v_earned integer;
  v_amount integer;
  v_shortfall integer;
  v_parts record;
  v_promo integer;
  v_purchased integer;
  v_from_promo integer;
  v_from_purchased integer;
  v_currency text;
  v_release_idempotency text;
  v_deduction_idempotency text;
  v_release_ledger_id uuid;
  v_deduction_ledger_id uuid;
  v_converted_reserve boolean := false;
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
     OR NOT public.is_commission_wallet_workflow_enabled(v_trip.service_area_id) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'WALLET_GATE_OFF');
  END IF;

  -- Trip snapshot override: if snapshot says CW off, skip (legacy / mis-snapshot).
  IF v_trip.financial_model IS NOT NULL
     AND v_trip.commission_wallet_enabled IS NOT NULL
     AND NOT (
       v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
       AND v_trip.commission_wallet_enabled IS TRUE
     ) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'TRIP_SNAPSHOT_GATE_OFF');
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
    -- Still ensure active reserve is marked converted if left behind.
    UPDATE public.driver_commission_wallet_reserves
    SET status = 'converted_to_deduction', updated_at = now()
    WHERE driver_id = p_driver_id
      AND trip_id = p_trip_id
      AND status = 'active';

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_existing_deduction_id,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION'
    );
  END IF;

  SELECT * INTO v_reserve
  FROM public.driver_commission_wallet_reserves
  WHERE driver_id = p_driver_id AND trip_id = p_trip_id
  FOR UPDATE;
  v_has_reserve := FOUND;

  -- Convert / release active reserve before balance split (usable includes former reserve).
  IF v_has_reserve AND v_reserve.status = 'active' THEN
    v_release_idempotency := left(
      'cw_reserve_convert_release_' || v_reserve.id::text,
      180
    );

    INSERT INTO public.driver_commission_wallet_ledger (
      driver_id,
      service_area_id,
      region_id,
      currency,
      entry_type,
      amount_minor,
      direction,
      trip_id,
      reason,
      promotional_portion_minor,
      purchased_portion_minor,
      idempotency_key,
      metadata
    ) VALUES (
      p_driver_id,
      v_reserve.service_area_id,
      v_sa.region_id,
      v_reserve.currency,
      'COMMISSION_RESERVE_RELEASE',
      v_reserve.reserved_amount_minor,
      'credit',
      p_trip_id,
      'Phase 7 convert reserve on trip complete',
      0,
      0,
      v_release_idempotency,
      jsonb_build_object(
        'phase', 'phase7_convert_release',
        'reserve_id', v_reserve.id,
        'revenue_source', 'COMMISSION_WALLET_DEDUCTION'
      )
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_release_ledger_id;

    IF v_release_ledger_id IS NULL THEN
      SELECT id INTO v_release_ledger_id
      FROM public.driver_commission_wallet_ledger
      WHERE idempotency_key = v_release_idempotency;
    END IF;

    UPDATE public.driver_commission_wallet_reserves
    SET
      status = 'converted_to_deduction',
      release_ledger_entry_id = COALESCE(v_release_ledger_id, release_ledger_entry_id),
      updated_at = now()
    WHERE id = v_reserve.id;
    v_converted_reserve := true;
  ELSIF v_has_reserve AND v_reserve.status = 'released' THEN
    -- Reserve already released (cancel path) — completion still deducts; leave status.
    NULL;
  END IF;

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
      'reserve_converted', v_converted_reserve
    );
  END IF;

  SELECT * INTO v_parts
  FROM public.driver_commission_wallet_balance_parts(p_driver_id, v_trip.service_area_id);

  v_promo := GREATEST(0, COALESCE(v_parts.promotional_balance_minor, 0));
  v_purchased := GREATEST(0, COALESCE(v_parts.purchased_balance_minor, 0));
  v_amount := LEAST(v_earned, GREATEST(0, COALESCE(v_parts.usable_commission_balance_minor, 0)));
  v_shortfall := GREATEST(0, v_earned - v_amount);

  v_from_promo := LEAST(v_amount, v_promo);
  v_from_purchased := LEAST(v_amount - v_from_promo, v_purchased);

  -- If portions under-cover due to rounding, prefer purchased remainder of amount.
  IF v_from_promo + v_from_purchased < v_amount THEN
    v_from_purchased := v_amount - v_from_promo;
  END IF;

  IF v_amount <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'ZERO_USABLE_AFTER_RELEASE',
      'commission_earned_minor', v_earned,
      'shortfall_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION'
    );
  END IF;

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    NULLIF(v_trip.snapshotted_commission_currency, ''),
    'USD'
  ));

  v_deduction_idempotency := left('cw_deduction_' || p_trip_id::text, 180);

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id,
    service_area_id,
    region_id,
    currency,
    entry_type,
    amount_minor,
    direction,
    trip_id,
    reason,
    promotional_portion_minor,
    purchased_portion_minor,
    idempotency_key,
    metadata
  ) VALUES (
    p_driver_id,
    v_trip.service_area_id,
    v_sa.region_id,
    v_currency,
    'COMMISSION_DEDUCTION',
    v_amount,
    'debit',
    p_trip_id,
    'Phase 7 completed-trip commission deduction',
    v_from_promo,
    v_from_purchased,
    v_deduction_idempotency,
    jsonb_build_object(
      'phase', 'phase7_deduction',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'commission_earned_minor', v_earned,
      'shortfall_minor', v_shortfall,
      'commissionable_fare_minor', COALESCE(p_commissionable_fare_minor, v_commissionable),
      'commission_rate_bps', COALESCE(p_commission_rate_bps, v_rate_bps)
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
      'amount_minor', v_amount,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION'
    );
  END IF;

  -- Snapshot trip financial model if still null (pilot path).
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
    'release_ledger_entry_id', v_release_ledger_id,
    'amount_minor', v_amount,
    'commission_earned_minor', v_earned,
    'shortfall_minor', v_shortfall,
    'promotional_portion_minor', v_from_promo,
    'purchased_portion_minor', v_from_purchased,
    'revenue_source', 'COMMISSION_WALLET_DEDUCTION'
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, amount_minor INTO v_deduction_ledger_id, v_amount
    FROM public.driver_commission_wallet_ledger
    WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_DEDUCTION'
    LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_amount,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION'
    );
END;
$$;

COMMENT ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) IS
  'Phase 7: convert active CW reserve and write one COMMISSION_DEDUCTION per trip. No-op when CW gate off.';

GRANT EXECUTE ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer)
  TO service_role;
