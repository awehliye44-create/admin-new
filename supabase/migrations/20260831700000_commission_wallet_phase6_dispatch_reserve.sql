-- Phase 6: Commission Wallet dispatch eligibility helpers + accept-time reserve/release.
-- UK / PLATFORM_COLLECTED: all functions no-op when gate is off.
-- Reserve attaches to driver_id + trip_id on assignment; release on driver clear / rematch / cancel.
-- Multiple reserve/release pairs per trip are allowed (rematch → re-accept); idempotency keys are attempt-scoped.

CREATE OR REPLACE FUNCTION public.is_commission_wallet_reserve_enabled(p_service_area_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.service_areas sa
    WHERE sa.id = p_service_area_id
      AND sa.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
      AND sa.commission_wallet_enabled = true
      AND sa.commission_reserve_enabled = true
  );
$$;

COMMENT ON FUNCTION public.is_commission_wallet_reserve_enabled(uuid) IS
  'Phase 6 gate: CW workflow + commission_reserve_enabled. Never true for PLATFORM_COLLECTED.';

CREATE OR REPLACE FUNCTION public.driver_commission_wallet_usable_balance_minor(
  p_driver_id uuid,
  p_service_area_id uuid
)
RETURNS integer
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
    RETURN 0;
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

  RETURN GREATEST(0, v_purchased + v_promotional - GREATEST(0, v_reserved));
END;
$$;

CREATE OR REPLACE FUNCTION public.required_commission_reserve_minor(
  p_estimated_final_fare_minor integer,
  p_commission_rate_bps integer
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT GREATEST(
    0,
    ROUND(
      (GREATEST(0, COALESCE(p_estimated_final_fare_minor, 0))::numeric
        * GREATEST(0, COALESCE(p_commission_rate_bps, 0))::numeric)
      / 10000.0
    )::integer
  );
$$;

CREATE OR REPLACE FUNCTION public.trip_commission_reserve_fare_minor(p_trip public.trips)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_fare integer;
BEGIN
  v_fare := NULLIF(GREATEST(0, COALESCE(p_trip.final_customer_fare_pence, 0)), 0);
  IF v_fare IS NULL THEN
    v_fare := NULLIF(GREATEST(0, COALESCE(p_trip.final_fare_pence, 0)), 0);
  END IF;
  IF v_fare IS NULL THEN
    v_fare := NULLIF(GREATEST(0, COALESCE(p_trip.accepted_driver_offer_fare_pence, 0)), 0);
  END IF;
  IF v_fare IS NULL THEN
    v_fare := NULLIF(GREATEST(0, COALESCE(p_trip.estimated_total_pence, 0)), 0);
  END IF;
  IF v_fare IS NULL THEN
    v_fare := NULLIF(ROUND(GREATEST(0, COALESCE(p_trip.estimated_fare, 0)) * 100)::integer, 0);
  END IF;
  RETURN COALESCE(v_fare, 0);
END;
$$;

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
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  -- Serialize concurrent accepts for the same driver.
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

  IF v_has_existing AND v_existing.status = 'active' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_RESERVED',
      'reserve_id', v_existing.id,
      'amount_minor', v_existing.reserved_amount_minor
    );
  END IF;

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

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    'USD'
  ));

  SELECT COUNT(*)::integer + 1 INTO v_attempt
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id
    AND entry_type = 'COMMISSION_RESERVE';

  v_idempotency := left(
    'cw_reserve_' || p_driver_id::text || '_' || p_trip_id::text || '_' || v_attempt::text,
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
    v_trip.service_area_id,
    v_sa.region_id,
    v_currency,
    'COMMISSION_RESERVE',
    v_required,
    'debit',
    p_trip_id,
    'Phase 6 accept-time commission reserve',
    0,
    0,
    v_idempotency,
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
    driver_id,
    service_area_id,
    trip_id,
    currency,
    reserved_amount_minor,
    status,
    reserve_ledger_entry_id
  ) VALUES (
    p_driver_id,
    v_trip.service_area_id,
    p_trip_id,
    v_currency,
    v_required,
    'active',
    v_ledger_id
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

  -- Snapshot financial model on trip when missing (Phase 6 soft fill; never overwrite UK).
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

CREATE OR REPLACE FUNCTION public.release_driver_commission_wallet(
  p_driver_id uuid,
  p_trip_id uuid,
  p_reason text DEFAULT 'assignment_cleared'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reserve public.driver_commission_wallet_reserves%ROWTYPE;
  v_idempotency text;
  v_ledger_id uuid;
  v_sa public.service_areas%ROWTYPE;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;

  SELECT * INTO v_reserve
  FROM public.driver_commission_wallet_reserves
  WHERE driver_id = p_driver_id AND trip_id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'NO_RESERVE_ROW');
  END IF;

  IF v_reserve.status = 'released' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_RELEASED',
      'reserve_id', v_reserve.id
    );
  END IF;

  IF v_reserve.status = 'converted_to_deduction' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'RESERVE_CONVERTED',
      'reserve_id', v_reserve.id
    );
  END IF;

  IF v_reserve.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'NOT_ACTIVE');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_reserve.service_area_id;

  v_idempotency := left(
    'cw_reserve_release_' || v_reserve.id::text || '_' || COALESCE(v_reserve.reserve_ledger_entry_id::text, 'none'),
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
    COALESCE(NULLIF(trim(p_reason), ''), 'assignment_cleared'),
    0,
    0,
    v_idempotency,
    jsonb_build_object('phase', 'phase6_reserve_release', 'reason', p_reason)
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    SELECT id INTO v_ledger_id
    FROM public.driver_commission_wallet_ledger
    WHERE idempotency_key = v_idempotency;
  END IF;

  UPDATE public.driver_commission_wallet_reserves
  SET
    status = 'released',
    release_ledger_entry_id = v_ledger_id,
    updated_at = now()
  WHERE id = v_reserve.id;

  RETURN jsonb_build_object(
    'ok', true,
    'reserve_id', v_reserve.id,
    'ledger_entry_id', v_ledger_id,
    'amount_minor', v_reserve.reserved_amount_minor,
    'reason', p_reason
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Release when assignment cleared (cancel / rematch / terminal).
  IF OLD.driver_id IS NOT NULL
     AND (NEW.driver_id IS NULL OR NEW.driver_id IS DISTINCT FROM OLD.driver_id) THEN
    v_result := public.release_driver_commission_wallet(
      OLD.driver_id,
      NEW.id,
      CASE
        WHEN NEW.driver_id IS NULL THEN 'assignment_cleared'
        ELSE 'driver_reassigned'
      END
    );
    -- Release is best-effort soft success; never block clear for non-CW trips.
    IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
      RAISE WARNING 'commission wallet release failed: %', v_result;
    END IF;
  END IF;

  -- Reserve on new assignment (accept / stacked accept / reassign).
  IF NEW.driver_id IS NOT NULL
     AND NEW.driver_id IS DISTINCT FROM OLD.driver_id THEN
    v_result := public.reserve_driver_commission_wallet(NEW.driver_id, NEW.id);
    IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
      IF COALESCE(v_result->>'skipped', 'false') = 'true'
         OR COALESCE(v_result->>'code', '') IN ('WALLET_GATE_OFF', 'ZERO_RESERVE') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION '%', COALESCE(v_result->>'error', v_result->>'code', 'COMMISSION_RESERVE_FAILED')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_wallet_on_trip_assignment ON public.trips;
CREATE TRIGGER trg_commission_wallet_on_trip_assignment
  AFTER UPDATE OF driver_id ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_commission_wallet_on_trip_assignment();

GRANT EXECUTE ON FUNCTION public.is_commission_wallet_reserve_enabled(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.required_commission_reserve_minor(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) IS
  'Phase 6: atomically reserve commission on accept when CW reserve enabled. Rolls back accept on insufficient balance.';
COMMENT ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) IS
  'Phase 6: release active reserve (no deduction) on cancel/rematch/assignment clear.';
