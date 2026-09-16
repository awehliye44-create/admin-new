-- Rollback 20260916220000_atomic_fare_increase_modification_claim
-- Drops claim/unresolved RPCs and apply-events table. Does NOT drop
-- payment_session_authorisations.trip_change_request_id (safe to leave).
BEGIN;

DROP FUNCTION IF EXISTS public.claim_and_apply_fare_increase_modification(
  uuid, uuid, integer, text, integer, boolean, integer
);
DROP FUNCTION IF EXISTS public.trip_has_unresolved_fare_increase_modification(uuid);

DROP TABLE IF EXISTS public.trip_modification_apply_events;

COMMIT;
