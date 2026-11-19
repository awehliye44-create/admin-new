-- ============================================================================
-- Bug #47 — accept_ride_offer: fail-fast lock wait + retry (rematch contention)
--
-- Production MK-261119-006 (trip f83dbf1f…, rematch offer cca2034b…):
--   Driver B Accept hit accept_ride_offer while rematch dispatch still held the
--   trip FOR UPDATE. Postgres waited until statement_timeout (~10s) then
--   returned "canceling statement due to statement timeout". Edge surfaced
--   DATABASE_ERROR; Driver stayed on Accepting… until a delayed popup.
--   Second Accept (~19s later) succeeded in ~3.3s once the lock was free.
--
-- Fix (wrapper only — core assignment / payment / Revolut unchanged):
--   * SET LOCAL lock_timeout = '1500ms' so trip-lock waits fail fast (55P03)
--     instead of burning the statement_timeout budget.
--   * Retry deadlock / serialization / lock_not_available up to 5 attempts with
--     short backoff (covers rematch dispatch releasing the trip lock).
--   * Never retry query_canceled blindly as success; contention_result decides.
--   * Idempotent core short-circuit preserved via accept_ride_offer_contention_result.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.accept_ride_offer(
  p_offer_id uuid,
  p_driver_id uuid,
  p_allow_customer_counter boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempt integer := 0;
  v_max_attempts constant integer := 5;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      -- Fail fast on rematch / dispatch trip-lock contention (Bug #47).
      -- Subtransaction: lock_timeout / deadlock rolls back only this attempt.
      PERFORM set_config('lock_timeout', '1500ms', true);

      RETURN public.accept_ride_offer_core(
        p_offer_id,
        p_driver_id,
        p_allow_customer_counter
      );
    EXCEPTION
      WHEN deadlock_detected
        OR serialization_failure
        OR lock_not_available
      THEN
        IF v_attempt >= v_max_attempts THEN
          RETURN public.accept_ride_offer_contention_result(p_offer_id, p_driver_id);
        END IF;
        PERFORM pg_sleep(0.04 * v_attempt + random() * 0.05);
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) IS
  'Single-winner offer acceptance (wrapper). Retries deadlock/serialization/lock_not_available up to 5x with lock_timeout=1.5s (Bug #47 rematch). Domain errors via accept_ride_offer_contention_result — never raw 40P01/55P03. Body: accept_ride_offer_core.';

COMMIT;
