-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- Schedule the financial-ssot-monitor Edge function (hourly). It was documented as
-- "invoke via pg_cron" but no migration ever scheduled it, so the fare scans AND the five
-- invariant scans (offer_vs_committed, airport_component_missing, driver_net_vs_breakdown,
-- overlapping_waiting_open, invalid_assignment_ownership) only ran when invoked by hand.
--
-- Pattern = expire_offers_sweep / scheduled_dispatch_sweep:
--   * SECURITY DEFINER sweep function, vault service-role token via public.cron_edge_auth_token()
--     (never a hardcoded anon/fallback JWT), net.http_post, failures only RAISE LOG.
--   * cron.unschedule(name) then cron.schedule(name, ...) so re-applying is idempotent.
--   * The function is read-only (fare / invariant scans -> financial_ssot_mismatches rows) and
--     itself guarded by assertCronOrServiceRoleAuth.
--
-- Safe where pg_cron is absent (local / CI Postgres harness): the whole scheduling block is a
-- no-op unless the `cron` schema exists. Nothing here touches payments, ledgers or trips.
--
-- Rollback: supabase/migrations/rollback/rollback_20270222200000_schedule_financial_ssot_monitor_cron.sql

CREATE OR REPLACE FUNCTION public.financial_ssot_monitor_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_financial_ssot_monitor_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/financial-ssot-monitor'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[financial-ssot-monitor] sweep aborted reason=bad_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token
      ),
      body := jsonb_build_object('source', 'pg_cron'),
      timeout_milliseconds := 120000
    );
    RAISE LOG '[financial-ssot-monitor] sweep enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[financial-ssot-monitor] sweep failed sqlerrm=%', SQLERRM;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.financial_ssot_monitor_sweep() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.financial_ssot_monitor_sweep() TO service_role;

DO $schedule$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed - financial-ssot-monitor hourly schedule skipped';
    RETURN;
  END IF;

  BEGIN
    PERFORM cron.unschedule('financial-ssot-monitor-hourly');
  EXCEPTION WHEN OTHERS THEN
    NULL; -- not scheduled yet
  END;

  PERFORM cron.schedule(
    'financial-ssot-monitor-hourly',
    '17 * * * *',
    'SELECT public.financial_ssot_monitor_sweep();'
  );
END
$schedule$;
