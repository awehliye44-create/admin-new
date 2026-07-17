CREATE OR REPLACE FUNCTION public.trg_protect_authorised_hold()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_release_trigger text;
  v_open_recovery uuid;
  v_going_terminal boolean;
BEGIN
  IF NEW.purpose IS DISTINCT FROM 'RIDE_BOOKING' THEN RETURN NEW; END IF;
  v_going_terminal := (
    COALESCE(NEW.provider_state, '') IN ('CANCELLED','FAILED','EXPIRED')
    AND COALESCE(OLD.provider_state, '') = 'AUTHORISED'
  );
  IF NOT v_going_terminal THEN RETURN NEW; END IF;

  v_release_trigger := COALESCE(NEW.metadata->>'release_trigger', '');

  IF NEW.provider_state = 'EXPIRED' THEN
    IF v_release_trigger = '' THEN
      NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
        || jsonb_build_object('release_trigger','provider_expired','release_trigger_at', now());
    END IF;
    RETURN NEW;
  END IF;

  IF v_release_trigger NOT IN ('capture_success','recovery_captured','admin_abandon_recovery') THEN
    SELECT id INTO v_open_recovery FROM public.payment_sessions
     WHERE trip_id = NEW.trip_id AND purpose = 'PAYMENT_RECOVERY'
       AND UPPER(COALESCE(status,'')) IN ('PAYMENT_RECOVERY_REQUIRED','RECOVERY_CHECKOUT_CREATED','CUSTOMER_ACTION_REQUIRED')
     LIMIT 1;
    IF v_open_recovery IS NOT NULL THEN
      RAISE EXCEPTION 'HOLD_PROTECTED_BY_RECOVERY: authorised hold cannot be released while payment recovery % is in flight', v_open_recovery
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_protect_authorised_hold ON public.payment_sessions;
CREATE TRIGGER trg_protect_authorised_hold
BEFORE UPDATE OF provider_state, status ON public.payment_sessions
FOR EACH ROW EXECUTE FUNCTION public.trg_protect_authorised_hold();

CREATE OR REPLACE VIEW public.v_payment_lifecycle_audit
WITH (security_invoker = on) AS
SELECT
  t.id AS trip_id, t.trip_code, t.payment_status AS trip_payment_status,
  parent.id AS parent_session_id, parent.provider_order_id AS parent_order_id,
  parent.provider_state AS parent_provider_state, parent.status AS parent_status,
  parent.authorised_amount_pence, parent.captured_amount_pence,
  parent.metadata->>'additional_auth_status' AS additional_auth_status,
  parent.metadata->>'release_trigger' AS release_trigger,
  parent.metadata->>'release_trigger_at' AS release_trigger_at,
  recovery.id AS recovery_session_id, recovery.provider_order_id AS recovery_order_id,
  recovery.status AS recovery_status, recovery.captured_amount_pence AS recovery_captured_pence,
  recovery.created_at AS recovery_created_at
FROM public.trips t
LEFT JOIN LATERAL (
  SELECT * FROM public.payment_sessions s WHERE s.trip_id = t.id AND s.purpose = 'RIDE_BOOKING'
  ORDER BY s.created_at DESC LIMIT 1
) parent ON true
LEFT JOIN LATERAL (
  SELECT * FROM public.payment_sessions s WHERE s.trip_id = t.id AND s.purpose = 'PAYMENT_RECOVERY'
  ORDER BY s.created_at DESC LIMIT 1
) recovery ON true;

GRANT SELECT ON public.v_payment_lifecycle_audit TO authenticated, service_role;