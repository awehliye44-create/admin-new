-- ROLLBACK candidate for 20261112180000_atomic_fare_increase_modification_claim.sql
-- FAIL CLOSED if apply-event rows or trip_change_request_id column values exist.
-- DO NOT APPLY unless matching forward draft was applied under an approved version.
--
BEGIN;

-- 1) Refuse if apply-event audit rows exist.
DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.trip_modification_apply_events') IS NOT NULL THEN
    SELECT count(*) INTO n FROM public.trip_modification_apply_events;
    IF n > 0 THEN
      RAISE EXCEPTION
        'ROLLBACK_REFUSED: trip_modification_apply_events has % row(s); refusing drop of populated audit structure',
        n;
    END IF;
  END IF;
END $$;

-- 2) Refuse if any authorisation row is linked via the claim column.
DO $$
DECLARE
  n bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_session_authorisations'
      AND column_name = 'trip_change_request_id'
  ) THEN
    EXECUTE 'SELECT count(*) FROM public.payment_session_authorisations WHERE trip_change_request_id IS NOT NULL'
      INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'ROLLBACK_REFUSED: payment_session_authorisations.trip_change_request_id is populated on % row(s); refusing drop',
        n;
    END IF;
  END IF;
END $$;

-- 3) Safe to remove empty structures / unbound functions only.
DROP FUNCTION IF EXISTS public.claim_and_apply_fare_increase_modification(
  uuid, uuid, integer, text, integer, boolean, integer
);

DROP FUNCTION IF EXISTS public.trip_has_unresolved_fare_increase_modification(uuid);

DROP TABLE IF EXISTS public.trip_modification_apply_events;

DROP INDEX IF EXISTS public.uq_psa_additional_auth_confirmed_per_modification;
DROP INDEX IF EXISTS public.uq_psa_idempotency_key_not_null;

ALTER TABLE public.payment_session_authorisations
  DROP CONSTRAINT IF EXISTS payment_session_authorisations_trip_change_request_id_fkey;

ALTER TABLE public.payment_session_authorisations
  DROP COLUMN IF EXISTS trip_change_request_id;

COMMIT;
