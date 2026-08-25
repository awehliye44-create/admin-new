-- expire-offers is the sole negotiation timeout owner.
-- Unschedule the leftover 15s guarded twin and keep the wrapper as a skip
-- so a rebuild cannot revive competing timeout outcomes.

DO $$
BEGIN
  PERFORM cron.unschedule('expire_stale_negotiations_15s');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'expire_stale_negotiations_15s unschedule: %', SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION public.expire_stale_negotiations_guarded()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN json_build_object(
    'skipped', true,
    'reason', 'expire_offers_owns_timeouts'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_negotiations_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT false;
$function$;

CREATE OR REPLACE FUNCTION public.expire_stale_negotiations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'processed', 0,
    'ran_at', now(),
    'skipped', true,
    'reason', 'expire_offers_owns_timeouts'
  );
END;
$function$;
