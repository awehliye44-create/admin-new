-- DRAFT rollback — only after Ahmed-approved apply of the forward draft.
DROP FUNCTION IF EXISTS public.claim_corporate_schedule_hold(uuid, text, timestamptz, integer, integer);
DROP TABLE IF EXISTS public.corporate_schedule_holds;
