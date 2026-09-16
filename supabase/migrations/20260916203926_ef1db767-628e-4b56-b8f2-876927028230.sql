CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_pending_run_at
  ON public.dispatch_jobs (run_at)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.dispatch_jobs_sweep_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.dispatch_jobs dj
    WHERE dj.status = 'pending'
      AND dj.run_at <= now()
    LIMIT 1
  );
$function$;

REVOKE ALL ON FUNCTION public.dispatch_jobs_sweep_has_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_jobs_sweep_has_work() TO service_role;

CREATE OR REPLACE FUNCTION public.dispatch_jobs_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_ride_offer_reminders_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/ride-offer-reminders'
  );
  v_token text := coalesce(
    nullif(trim(current_setting('app.settings.service_role_key', true)), ''),
    nullif(trim(current_setting('supabase.service_role_key', true)), ''),
    public.cron_edge_auth_token()
  );
BEGIN
  -- Disk IO guard: the edge tick only processes due dispatch_jobs rows,
  -- so skip the HTTP call entirely when the queue has nothing due.
  IF NOT public.dispatch_jobs_sweep_has_work() THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RETURN;
  END IF;

  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[dispatch] dispatch_jobs_sweep aborted reason=bad_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token
      ),
      body := '{"action": "tick"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[dispatch] dispatch_jobs_sweep HTTP POST failed: %', SQLERRM;
  END;
END;
$function$;