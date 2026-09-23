-- Rollback 20261127120000 → restore broader unresolved detection
-- (payment_required/pending/confirmed + payment_status required/pending).
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
