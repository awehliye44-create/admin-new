
-- Extend allowed ledger types to include the operational-expense compensation entry
ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
CHECK (type = ANY (ARRAY[
  'TRIP_EARNING_NET','CASH_TRIP_EARNING','CASH_COMMISSION_DEBT','DRIVER_TIP_CREDIT','TIP_CREDIT',
  'PLATFORM_COMMISSION','COMPANY_COMMISSION','WEEKLY_PAYOUT','EARLY_CASHOUT','CASHOUT_FEE',
  'ADJUSTMENT','REFUND_DEBIT','PAYOUT','MANUAL_PAYOUT','BONUS','DEBT_RECOVERY','COMMISSION_RECOVERED',
  'LEDGER_REVERSAL','PAYOUT_FAILED_RETURN','PAYOUT_RESERVATION_HOLD','PAYOUT_RESERVATION_RELEASE',
  'OPS_DRIVER_COMPENSATION'
]));

-- 1. assert_payment_gate(trip_id)
CREATE OR REPLACE FUNCTION public.assert_payment_gate(p_trip_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_trip RECORD; v_ps RECORD; v_method text;
BEGIN
  SELECT id, payment_method, payment_session_id, currency_code INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001'; END IF;
  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN RETURN; END IF;
  IF v_trip.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % has no payment_session_id', p_trip_id USING ERRCODE='P0001';
  END IF;
  SELECT id, status, provider_state, authorised_amount_pence, currency INTO v_ps
    FROM public.payment_sessions WHERE id = v_trip.payment_session_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session missing' USING ERRCODE='P0001'; END IF;
  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state USING ERRCODE='P0001';
  END IF;
  IF v_ps.status::text IN ('cancelled','failed','payment_orphaned','orphan_authorisation') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status USING ERRCODE='P0001';
  END IF;
  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_ps.authorised_amount_pence USING ERRCODE='P0001';
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION public.assert_payment_gate(uuid) TO authenticated, service_role;

-- 2. finalize_paid_booking_session
CREATE OR REPLACE FUNCTION public.finalize_paid_booking_session(p_payment_session_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ps RECORD; v_draft jsonb; v_trip_id uuid; v_existing_trip uuid; v_method text;
BEGIN
  IF p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session_id required' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_ps FROM public.payment_sessions WHERE id = p_payment_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session not found' USING ERRCODE='P0001';
  END IF;
  IF v_ps.trip_id IS NOT NULL THEN RETURN v_ps.trip_id; END IF;
  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state USING ERRCODE='P0001';
  END IF;
  IF v_ps.status::text IN ('cancelled','failed','payment_orphaned','orphan_authorisation','pending_payment','authorising') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status USING ERRCODE='P0001';
  END IF;
  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_ps.authorised_amount_pence USING ERRCODE='P0001';
  END IF;
  v_draft := COALESCE(v_ps.booking_snapshot,'{}'::jsonb);
  IF v_draft = '{}'::jsonb THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: booking_snapshot missing' USING ERRCODE='P0001';
  END IF;
  IF LOWER(COALESCE(v_ps.currency,'')) <> LOWER(COALESCE(v_draft->>'currency_code', v_ps.currency, '')) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: currency mismatch' USING ERRCODE='P0001';
  END IF;
  IF v_ps.service_area_id IS NULL
     OR (v_draft ? 'service_area_id' AND v_draft->>'service_area_id' <> v_ps.service_area_id::text) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: service_area mismatch' USING ERRCODE='P0001';
  END IF;
  IF v_ps.customer_id IS NULL
     OR (v_draft ? 'customer_id' AND v_draft->>'customer_id' <> v_ps.customer_id::text) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: customer mismatch' USING ERRCODE='P0001';
  END IF;
  IF (v_draft->>'estimated_fare_pence')::int IS NOT NULL
     AND (v_draft->>'estimated_fare_pence')::int > v_ps.authorised_amount_pence THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: draft fare exceeds authorised amount' USING ERRCODE='P0001';
  END IF;
  v_method := UPPER(COALESCE(v_draft->>'payment_method', v_ps.payment_method, 'CARD'));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: unsupported payment_method %', v_method USING ERRCODE='P0001';
  END IF;
  SELECT id INTO v_existing_trip FROM public.trips WHERE payment_session_id = v_ps.id LIMIT 1;
  IF v_existing_trip IS NOT NULL THEN
    UPDATE public.payment_sessions SET trip_id = v_existing_trip, updated_at = now() WHERE id = v_ps.id;
    RETURN v_existing_trip;
  END IF;
  INSERT INTO public.trips (
    passenger_id, passenger_name, passenger_phone,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude,
    vehicle_type_id, estimated_fare, estimated_distance_km, estimated_duration_minutes,
    special_instructions, is_scheduled, scheduled_at,
    payment_method, payment_type, trip_type, status,
    currency_code, service_area_id, booking_source,
    payment_session_id, payment_provider, provider_order_id, payment_status
  ) VALUES (
    (v_draft->>'passenger_user_id')::uuid,
    v_draft->>'passenger_name', v_draft->>'passenger_phone',
    v_draft->>'pickup_address',
    NULLIF(v_draft->>'pickup_latitude','')::numeric, NULLIF(v_draft->>'pickup_longitude','')::numeric,
    v_draft->>'dropoff_address',
    NULLIF(v_draft->>'dropoff_latitude','')::numeric, NULLIF(v_draft->>'dropoff_longitude','')::numeric,
    NULLIF(v_draft->>'vehicle_type_id','')::uuid,
    COALESCE((v_draft->>'estimated_fare_pence')::numeric/100.0, 0),
    NULLIF(v_draft->>'estimated_distance_km','')::numeric,
    NULLIF(v_draft->>'estimated_duration_minutes','')::int,
    COALESCE(v_draft->>'special_instructions',''),
    COALESCE((v_draft->>'is_scheduled')::boolean,false),
    NULLIF(v_draft->>'scheduled_at','')::timestamptz,
    v_method, v_method,
    CASE WHEN COALESCE((v_draft->>'is_scheduled')::boolean,false) THEN 'scheduled' ELSE 'immediate' END,
    'searching', v_ps.currency, v_ps.service_area_id,
    COALESCE(v_draft->>'booking_source','customer_app'),
    v_ps.id, v_ps.payment_provider, v_ps.provider_order_id, 'authorized'
  ) RETURNING id INTO v_trip_id;
  UPDATE public.payment_sessions SET trip_id = v_trip_id, updated_at = now() WHERE id = v_ps.id;
  INSERT INTO public.audit_logs (event_type, trip_id, details, created_at)
  VALUES ('DIGITAL_TRIP_FINALIZED', v_trip_id,
    jsonb_build_object('payment_session_id',v_ps.id,'provider_state',v_ps.provider_state,
      'authorised_amount_pence',v_ps.authorised_amount_pence,'provider_order_id',v_ps.provider_order_id),
    now());
  RETURN v_trip_id;
END; $$;
GRANT EXECUTE ON FUNCTION public.finalize_paid_booking_session(uuid) TO authenticated, service_role;

-- 3. Historical audit
CREATE OR REPLACE FUNCTION public.payment_gate_historical_audit()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  SELECT jsonb_build_object(
    'generated_at', now(),
    'digital_trips_no_session', (SELECT jsonb_build_object('count',COUNT(*),'ids',COALESCE(jsonb_agg(id),'[]'::jsonb))
      FROM public.trips WHERE UPPER(COALESCE(payment_method,'')) IN ('CARD','APPLE_PAY','GOOGLE_PAY')
        AND payment_session_id IS NULL AND status <> 'cancelled'),
    'digital_trips_provider_pending', (SELECT jsonb_build_object('count',COUNT(*),'ids',COALESCE(jsonb_agg(t.id),'[]'::jsonb))
      FROM public.trips t JOIN public.payment_sessions ps ON ps.id=t.payment_session_id
      WHERE UPPER(COALESCE(t.payment_method,'')) IN ('CARD','APPLE_PAY','GOOGLE_PAY')
        AND UPPER(COALESCE(ps.provider_state,''))='PENDING'),
    'trips_broadcast_before_authorization', (SELECT jsonb_build_object('count',COUNT(*),'ids',COALESCE(jsonb_agg(t.id),'[]'::jsonb))
      FROM public.trips t LEFT JOIN public.payment_sessions ps ON ps.id=t.payment_session_id
      WHERE UPPER(COALESCE(t.payment_method,'')) IN ('CARD','APPLE_PAY','GOOGLE_PAY')
        AND t.status IN ('searching','broadcasting','offered','accepted','completed','in_progress')
        AND (ps.id IS NULL OR UPPER(COALESCE(ps.provider_state,'')) NOT IN ('AUTHORISED','COMPLETED'))),
    'captured_sessions_no_trip', (SELECT jsonb_build_object('count',COUNT(*),'ids',COALESCE(jsonb_agg(id),'[]'::jsonb))
      FROM public.payment_sessions WHERE status::text IN ('captured','completed_pending_capture','CAPTURE_CONFIRMED') AND trip_id IS NULL),
    'orphan_provider_orders', (SELECT jsonb_build_object('count',COUNT(*),'ids',COALESCE(jsonb_agg(id),'[]'::jsonb))
      FROM public.payment_sessions WHERE status::text IN ('payment_orphaned','orphan_authorisation')),
    'sessions_pre_marked_authorised_without_provider', (SELECT jsonb_build_object('count',COUNT(*),'ids',COALESCE(jsonb_agg(id),'[]'::jsonb))
      FROM public.payment_sessions WHERE COALESCE(authorised_amount_pence,0)>0
        AND UPPER(COALESCE(provider_state,'')) NOT IN ('AUTHORISED','COMPLETED'))
  ) INTO r;
  RETURN r;
END; $$;
GRANT EXECUTE ON FUNCTION public.payment_gate_historical_audit() TO authenticated, service_role;

-- 4. OPS_DRIVER_COMPENSATION for MK-260716-005 (idempotent)
DO $$
DECLARE
  v_trip_id uuid := 'c764aa9f-1137-41e4-9741-a47da3c49477';
  v_driver_id uuid := 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';
  v_fare_pence int := 480;
  v_commission_pct numeric;
  v_driver_net_pence int;
  v_exists boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.driver_wallet_ledger
    WHERE related_trip_id=v_trip_id AND type='OPS_DRIVER_COMPENSATION') INTO v_exists;
  IF v_exists THEN RETURN; END IF;

  SELECT COALESCE(dc.commission_pct, 20) INTO v_commission_pct
    FROM public.drivers d
    LEFT JOIN public.driver_categories dc ON dc.id = d.category_id
   WHERE d.id = v_driver_id;
  v_commission_pct := COALESCE(v_commission_pct, 20);
  v_driver_net_pence := v_fare_pence - FLOOR(v_fare_pence * v_commission_pct / 100.0)::int;

  INSERT INTO public.driver_wallet_ledger (driver_id, type, amount_pence, currency, related_trip_id, description, service_area_id)
  SELECT v_driver_id, 'OPS_DRIVER_COMPENSATION', v_driver_net_pence, 'GBP', v_trip_id,
    format('OPS_DRIVER_COMPENSATION for MK-260716-005 (PAYMENT_GATE_BREACH_NO_CAPTURE). Funded by ONECAB operational funds. Driver-net %s pence (fare %s - commission %s%%). NOT customer-funded trip earnings, NOT a card capture.',
      v_driver_net_pence, v_fare_pence, v_commission_pct),
    service_area_id
    FROM public.trips WHERE id = v_trip_id;

  INSERT INTO public.audit_logs (event_type, trip_id, details, created_at)
  VALUES ('OPS_DRIVER_COMPENSATION_ISSUED', v_trip_id,
    jsonb_build_object('reason','PAYMENT_GATE_BREACH_NO_CAPTURE','driver_id',v_driver_id,
      'fare_pence',v_fare_pence,'commission_pct',v_commission_pct,'driver_net_pence',v_driver_net_pence,
      'source','ONECAB operational expense',
      'note','Not customer capture, not commission, not provider fee. Operational incident expense.'),
    now());
END $$;

-- 5. Guard payment_sessions authoritative writes
CREATE OR REPLACE FUNCTION public.enforce_payment_session_authority()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_role text := current_setting('request.jwt.claim.role', true);
BEGIN
  IF v_role = 'service_role' OR v_role IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.authorised_amount_pence,0) > 0
       OR UPPER(COALESCE(NEW.provider_state,'')) IN ('AUTHORISED','COMPLETED') THEN
      RAISE EXCEPTION 'PAYMENT_AUTHORITY_VIOLATION: only provider webhook may set authorised amount/state' USING ERRCODE='P0001';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (COALESCE(NEW.authorised_amount_pence,0) <> COALESCE(OLD.authorised_amount_pence,0))
       OR (UPPER(COALESCE(NEW.provider_state,'')) IN ('AUTHORISED','COMPLETED')
           AND UPPER(COALESCE(OLD.provider_state,'')) NOT IN ('AUTHORISED','COMPLETED')) THEN
      RAISE EXCEPTION 'PAYMENT_AUTHORITY_VIOLATION: only provider webhook may mutate authorised amount/state' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_enforce_payment_session_authority ON public.payment_sessions;
CREATE TRIGGER trg_enforce_payment_session_authority
BEFORE INSERT OR UPDATE ON public.payment_sessions
FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_session_authority();
