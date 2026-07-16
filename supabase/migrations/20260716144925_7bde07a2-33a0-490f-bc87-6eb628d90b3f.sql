
CREATE OR REPLACE FUNCTION public.enforce_digital_payment_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_method text := UPPER(COALESCE(NEW.payment_method, ''));
  v_new_status text := LOWER(COALESCE(NEW.status, ''));
  v_old_status text := LOWER(COALESCE(OLD.status, ''));
  v_gated_states text[] := ARRAY[
    'searching','searching_new_driver','broadcasting',
    'offered','offering','negotiating','driver_notified',
    'awaiting_driver_response','accepted','confirmed',
    'driver_assigned','assigned','queued',
    'en_route','en_route_to_pickup','driver_en_route','enroute_to_pickup',
    'driver_arriving','arrived','arrived_pickup','arrived_at_pickup',
    'at_pickup','pickup_waiting','waiting','waiting_at_pickup',
    'in_progress','started','on_trip','ongoing','trip_started','completed'
  ];
  v_ps RECORD;
BEGIN
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  IF NOT (v_new_status = ANY(v_gated_states)) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND v_old_status = ANY(v_gated_states) THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: digital-payment trip requires payment_session_id (trip=%, method=%)',
      NEW.id, v_method USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, provider_state, currency, authorised_amount_pence
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = NEW.payment_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session % not found', NEW.payment_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=% for session % (trip=%)',
      v_ps.provider_state, v_ps.id, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF v_ps.status IN ('cancelled','failed','expired','abandoned','payment_orphaned') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=% (trip=%)', v_ps.status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF LOWER(COALESCE(v_ps.currency,'')) <> LOWER(COALESCE(NEW.currency, v_ps.currency, '')) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: currency mismatch session=% trip=%',
      v_ps.currency, NEW.currency USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=% for session %',
      v_ps.authorised_amount_pence, v_ps.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_digital_payment_gate_ins ON public.trips;
DROP TRIGGER IF EXISTS trg_enforce_digital_payment_gate_upd ON public.trips;

CREATE TRIGGER trg_enforce_digital_payment_gate_ins
BEFORE INSERT ON public.trips
FOR EACH ROW EXECUTE FUNCTION public.enforce_digital_payment_gate();

CREATE TRIGGER trg_enforce_digital_payment_gate_upd
BEFORE UPDATE OF status ON public.trips
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.enforce_digital_payment_gate();

COMMENT ON FUNCTION public.enforce_digital_payment_gate() IS
  'P0 payment gate: digital-payment trips cannot enter dispatch-visible states unless their payment_sessions row shows provider_state AUTHORISED/COMPLETED with matching currency and positive authorised amount.';

UPDATE public.payment_sessions
   SET status = 'payment_orphaned',
       failure_reason = COALESCE(failure_reason, 'PAYMENT_GATE_BREACH_NO_CAPTURE — provider_state remained PENDING, no ORDER_AUTHORISED webhook received'),
       updated_at = now()
 WHERE id = 'e19425a1-0ee4-4907-b84b-61e5e98b7af8'
   AND UPPER(COALESCE(provider_state,'')) = 'PENDING';

INSERT INTO public.audit_logs (event_type, trip_id, details, created_at)
VALUES (
  'PAYMENT_GATE_BREACH_NO_CAPTURE',
  'c764aa9f-1137-41e4-9741-a47da3c49477',
  jsonb_build_object(
    'trip_code','MK-260716-005',
    'payment_session_id','e19425a1-0ee4-4907-b84b-61e5e98b7af8',
    'provider_order_id','6a58ec1c-0b19-af7a-af0f-51a2a9be35f5',
    'provider_state','PENDING',
    'captured_amount_pence',0,
    'authorised_at_provider',false,
    'action_taken','incident_recorded_trip_preserved_no_wallet_no_commission',
    'reason','create-payment-intent set local payment_status=authorized without waiting for ORDER_AUTHORISED webhook; customer never completed checkout'
  ),
  now()
);
