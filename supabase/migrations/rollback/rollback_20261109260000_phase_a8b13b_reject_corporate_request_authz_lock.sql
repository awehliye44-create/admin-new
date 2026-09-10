-- Rollback Phase A8B13B. Drops reject_corporate_request (did not exist pre-phase).
-- Does not restore direct-table Admin UPDATE behaviour (that remains until A8B13B2).

BEGIN;

DROP FUNCTION IF EXISTS public.reject_corporate_request(uuid, text, uuid);

COMMIT;
