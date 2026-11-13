-- Rollback of 20270222200000: unschedule the hourly financial-ssot-monitor cron and drop the sweep.
DO $rb$
BEGIN
  IF to_regnamespace('cron') IS NOT NULL THEN
    BEGIN
      PERFORM cron.unschedule('financial-ssot-monitor-hourly');
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$rb$;

DROP FUNCTION IF EXISTS public.financial_ssot_monitor_sweep();
