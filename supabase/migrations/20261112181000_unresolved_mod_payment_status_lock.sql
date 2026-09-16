-- Migration 20260916223000: broaden unresolved fare-increase detection
-- Catch positive-delta mods whose payment_status is still required/pending even if
-- request status was wrongly advanced (MK-260916-030 fail-closed).
-- Rollback: rollback/rollback_20260916223000_unresolved_mod_payment_status_lock.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.trip_has_unresolved_fare_increase_modification(
  p_trip_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.trip_change_requests r
    WHERE r.trip_id = p_trip_id
      AND COALESCE(r.fare_delta_pence, 0) > 0
      AND (
        r.status IN (
          'payment_required',
          'payment_pending',
          'payment_confirmed'
        )
        OR lower(COALESCE(r.payment_status, '')) IN (
          'required',
          'pending'
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.trip_has_unresolved_fare_increase_modification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trip_has_unresolved_fare_increase_modification(uuid) TO service_role;

COMMIT;
