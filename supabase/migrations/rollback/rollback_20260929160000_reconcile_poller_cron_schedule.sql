-- ROLLBACK: 20260929160000_reconcile_poller_cron_schedule.sql
-- Unschedules only the named cron job.
-- Does NOT drop the Edge function.
-- Does NOT drop claim columns or RPCs (those are in migration 20260929150000).
-- Does NOT touch payout, reservation or wallet rows.

DO $$
DECLARE
  v_job_name TEXT := 'reconcile-submitted-driver-withdrawals-every-2-min';
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job_name) THEN
    PERFORM cron.unschedule(v_job_name);
    RAISE NOTICE 'Unscheduled cron job: %', v_job_name;
  ELSE
    RAISE NOTICE 'Cron job % not found, nothing to unschedule.', v_job_name;
  END IF;
END;
$$;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260929160000';

-- Verify job is gone
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-submitted-driver-withdrawals-every-2-min') THEN
    RAISE EXCEPTION 'Rollback failed: cron job still present.';
  END IF;
  RAISE NOTICE 'Rollback verification PASSED: cron job absent.';
END;
$$;
