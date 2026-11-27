-- Rollback B1 expire-offers single-flight lease (review/staging only until prod approved).

BEGIN;

DROP FUNCTION IF EXISTS public.release_expire_offers_lease(text);
DROP FUNCTION IF EXISTS public.try_claim_expire_offers_lease(text, integer);
DROP TABLE IF EXISTS public.expire_offers_single_flight_lease;

COMMIT;
