-- Pending / failed fare-increase modifications must NOT block Driver completion.
-- Route/fare stay on the original trip until payment is confirmed and applied.
-- Block completion only when payment is confirmed but apply not finished, or
-- when approved/applied slipped through with unpaid payment_status.
-- Rollback: rollback/rollback_20261127120000_pending_mod_does_not_block_completion.sql
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
        -- Money confirmed; claim/apply still in flight — serialize vs completion.
        r.status = 'payment_confirmed'
        -- Fail-closed: applied/approved must never sit with unpaid status.
        OR (
          r.status IN ('approved', 'applied')
          AND lower(COALESCE(r.payment_status, '')) IN ('required', 'pending')
        )
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.trip_has_unresolved_fare_increase_modification(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trip_has_unresolved_fare_increase_modification(uuid) TO service_role;

COMMIT;
