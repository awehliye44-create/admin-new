-- Restore scheduled-dispatch minute cron (marketplace broadcast + convert).
-- Isolated: do not replace the live schedule-dispatch-every-minute job.
-- MK-260817-006 class trips need this tick to convert at Admin urgent fallback.

CREATE OR REPLACE FUNCTION public.scheduled_dispatch_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_scheduled_dispatch_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/scheduled-dispatch'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RAISE LOG '[scheduled-dispatch] sweep aborted reason=bad_url';
    RETURN;
  END IF;

  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[scheduled-dispatch] sweep aborted reason=bad_token';
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
      body := jsonb_build_object('source', 'pg_cron')
    );
    RAISE LOG '[scheduled-dispatch] sweep enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[scheduled-dispatch] sweep failed sqlerrm=%', SQLERRM;
  END;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'scheduled-dispatch-every-minute'
  ) THEN
    PERFORM cron.schedule(
      'scheduled-dispatch-every-minute',
      '* * * * *',
      'SELECT public.scheduled_dispatch_sweep();'
    );
  END IF;
END $$;
