-- MK-260817-004: schedule-dispatch cron posted the anon JWT while the Edge
-- required service role, so no-preconfirmed jobs never converted at check-in.
-- Repoint the live cron to vault service-role auth (same as expire_offers_sweep).
-- Also restore scheduled-dispatch (marketplace broadcast + convert + commitment).

CREATE OR REPLACE FUNCTION public.schedule_dispatch_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_schedule_dispatch_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/schedule-dispatch'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[schedule-dispatch] sweep aborted reason=bad_token';
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
    RAISE LOG '[schedule-dispatch] sweep enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[schedule-dispatch] sweep failed sqlerrm=%', SQLERRM;
  END;
END;
$function$;

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
  PERFORM cron.unschedule('schedule-dispatch-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('scheduled-dispatch-every-minute');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'schedule-dispatch-every-minute',
  '* * * * *',
  $$SELECT public.schedule_dispatch_sweep();$$
);

SELECT cron.schedule(
  'scheduled-dispatch-every-minute',
  '* * * * *',
  $$SELECT public.scheduled_dispatch_sweep();$$
);
