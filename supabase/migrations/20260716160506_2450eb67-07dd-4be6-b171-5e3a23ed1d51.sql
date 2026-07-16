CREATE OR REPLACE FUNCTION public.prevent_authorised_session_client_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.status::text = 'cancelled'
     AND OLD.status::text IS DISTINCT FROM NEW.status::text
     AND UPPER(COALESCE(OLD.provider_state, NEW.provider_state, '')) IN ('AUTHORISED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: cannot client-cancel provider-authorised session %', OLD.id USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_authorised_session_client_cancel ON public.payment_sessions;
CREATE TRIGGER trg_prevent_authorised_session_client_cancel
BEFORE UPDATE OF status ON public.payment_sessions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_authorised_session_client_cancel();

REVOKE EXECUTE ON FUNCTION public.prevent_authorised_session_client_cancel() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_authorised_session_client_cancel() TO service_role;