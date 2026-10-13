-- Rollback for 20261216220000_payout_reliability_p2.sql
--
-- Roll back the Edge functions first (admin-execute-weekly-payout-occurrence
-- writes both tables), then run this.
--
-- The snapshot table is append-only by design, so its immutability triggers are
-- dropped before the table. Export both tables first if any rows exist — they
-- are evidence of what each /pay attempt relied on.

BEGIN;

DROP TRIGGER IF EXISTS payout_provider_reversal_checks_guard ON public.payout_provider_reversal_checks;
DROP TABLE IF EXISTS public.payout_provider_reversal_checks;
DROP FUNCTION IF EXISTS public.guard_payout_reversal_flag();

DROP TRIGGER IF EXISTS driver_payout_funding_attempt_snapshots_immutable ON public.driver_payout_funding_attempt_snapshots;
DROP TRIGGER IF EXISTS driver_payout_funding_attempt_snapshots_no_truncate ON public.driver_payout_funding_attempt_snapshots;
DROP TABLE IF EXISTS public.driver_payout_funding_attempt_snapshots;
DROP FUNCTION IF EXISTS public.reject_funding_snapshot_mutation();

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261216220000';

COMMIT;
