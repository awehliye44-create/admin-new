-- Fix trg_protect_authorised_hold: COALESCE(status, '') fails when status is
-- payment_session_status enum (casts '' → enum → 22P02), blocking legitimate
-- AUTHORISED → CANCELLED local reconciliation after provider already cancelled.

CREATE OR REPLACE FUNCTION public.trg_protect_authorised_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
       AND UPPER(COALESCE(status::text, '')) IN (
         'PAYMENT_RECOVERY_REQUIRED','RECOVERY_CHECKOUT_CREATED','CUSTOMER_ACTION_REQUIRED'
       )
     LIMIT 1;
    IF v_open_recovery IS NOT NULL THEN
      RAISE EXCEPTION 'HOLD_PROTECTED_BY_RECOVERY: authorised hold cannot be released while payment recovery % is in flight', v_open_recovery
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
