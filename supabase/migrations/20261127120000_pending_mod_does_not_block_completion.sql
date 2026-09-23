-- Fare-increase modification completion gate (MK-260923-002).
--
-- DECLINED / payment_failed must NEVER block Driver lifecycle.
-- UNKNOWN / payment_pending MUST still block (provider may yet confirm).
-- payment_confirmed (apply in flight) MUST still block.
--
-- Do NOT treat bare payment_status=pending as unresolved for payment_failed rows.
-- Roll forward from 20261112181000; rollback restores that broader gate.
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
        -- Genuinely unknown / still-processing provider outcome — protect completion.
        r.status = 'payment_pending'
        -- Money confirmed; claim/apply still in flight — serialize vs completion.
        OR r.status = 'payment_confirmed'
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
