-- P6 M2: cron disaster-recovery versioning.
--
-- Production already runs both jobs (jobids 62 / 71). This migration makes a
-- fresh project reproducible without changing production:
--   * public.sweep_revolut_stale_holds()  — captured verbatim from production
--     (it was only ever REVOKE'd in migrations, never defined).
--   * sweep-revolut-stale-holds-every-5min   (*/5 * * * *)
--   * sweep-pending-trip-invoices-every-5min (*/5 * * * *)
-- Names/schedules match scripts/financial_production_worker_inventory.json.
--
-- Idempotent: an existing job (by jobname) is never duplicated and its command is
-- never rewritten; only a drifted schedule is corrected. Neither job performs a
-- CAPTURE/INCREMENT itself — the Edge functions own that (GET-first).

-- 1) sweep_revolut_stale_holds() — verbatim production definition ---------------
CREATE OR REPLACE FUNCTION public.sweep_revolut_stale_holds()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_sweep_revolut_stale_holds_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/sweep-revolut-stale-holds'
  );
  v_token text := public.cron_edge_auth_token();
  v_cron_secret text := coalesce(
    nullif(trim(current_setting('app.settings.cron_secret', true)), ''),
    nullif(trim(current_setting('app.settings.onecab_internal_finalize_secret', true)), '')
  );
BEGIN
  IF v_url IS NULL OR length(trim(v_url)) < 20 OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[sweep-revolut-stale-holds] sweep aborted reason=bad_url_or_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token,
        'x-onecab-cron-secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      )),
      body := jsonb_strip_nulls(jsonb_build_object(
        'source', 'pg_cron',
        'sweep_at', now()::text,
        'cron_secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      ))
    );
    RAISE LOG '[sweep-revolut-stale-holds] edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[sweep-revolut-stale-holds] edge_invoke_failed url=% sqlerrm=%', v_url, SQLERRM;
  END;
END;
$function$;

-- Same ACL as production (20261107160000 authz lock): postgres only.
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM anon;
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM authenticated;
REVOKE ALL ON FUNCTION public.sweep_revolut_stale_holds() FROM service_role;

-- 2) pg_cron jobs ---------------------------------------------------------------
DO $$
DECLARE
  v_job_id bigint;
  v_schedule text;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'pg_cron not installed; skipping P6 M2 cron jobs.';
    RETURN;
  END IF;

  -- sweep-revolut-stale-holds-every-5min -> SELECT public.sweep_revolut_stale_holds()
  SELECT jobid, schedule INTO v_job_id, v_schedule
  FROM cron.job WHERE jobname = 'sweep-revolut-stale-holds-every-5min' LIMIT 1;
  IF FOUND THEN
    IF v_schedule IS DISTINCT FROM '*/5 * * * *' THEN
      PERFORM cron.alter_job(v_job_id, schedule := '*/5 * * * *');
    END IF;
  ELSE
    PERFORM cron.schedule(
      'sweep-revolut-stale-holds-every-5min',
      '*/5 * * * *',
      $cron_cmd$SELECT public.sweep_revolut_stale_holds();$cron_cmd$
    );
  END IF;

  -- sweep-pending-trip-invoices-every-5min -> net.http_post (vault service_role_key)
  SELECT jobid, schedule INTO v_job_id, v_schedule
  FROM cron.job WHERE jobname = 'sweep-pending-trip-invoices-every-5min' LIMIT 1;
  IF FOUND THEN
    IF v_schedule IS DISTINCT FROM '*/5 * * * *' THEN
      PERFORM cron.alter_job(v_job_id, schedule := '*/5 * * * *');
    END IF;
  ELSE
    PERFORM cron.schedule(
      'sweep-pending-trip-invoices-every-5min',
      '*/5 * * * *',
      $cron_cmd$
      SELECT net.http_post(
        url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/sweep-pending-trip-invoices',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'service_role_key' LIMIT 1
          )
        ),
        body := '{"limit":40}'::jsonb,
        timeout_milliseconds := 55000
      );
      $cron_cmd$
    );
  END IF;
END;
$$;
