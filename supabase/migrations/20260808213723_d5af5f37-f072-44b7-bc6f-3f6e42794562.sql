-- Automatic customer trip invoice email on trip completion.
BEGIN;

CREATE OR REPLACE FUNCTION public.invoke_trip_invoice_process(p_trip_id uuid, p_action text DEFAULT 'generate')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_trip_invoice_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/trip-invoice-process'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[trip-invoice] aborted reason=bad_token trip=%', p_trip_id;
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
      body := jsonb_build_object('trip_id', p_trip_id, 'action', p_action, 'source', 'auto')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[trip-invoice] invoke_failed trip=% sqlerrm=%', p_trip_id, SQLERRM;
  END;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.sweep_trip_invoice_emails()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_trip_invoice_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/trip-invoice-process'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[trip-invoice-sweep] aborted reason=bad_token';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token,
      'apikey', v_token
    ),
    body := jsonb_build_object('sweep', true)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.trg_trip_invoice_on_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status = 'completed'
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND coalesce(NEW.invoice_email_sent, false) = false THEN
    PERFORM public.invoke_trip_invoice_process(NEW.id, 'generate');
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_trip_invoice_on_completion ON public.trips;
CREATE TRIGGER trg_trip_invoice_on_completion
AFTER UPDATE OF status ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.trg_trip_invoice_on_completion();

REVOKE EXECUTE ON FUNCTION public.invoke_trip_invoice_process(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sweep_trip_invoice_emails() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_trip_invoice_process(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sweep_trip_invoice_emails() TO service_role;

SELECT cron.unschedule('trip-invoice-email-sweep')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'trip-invoice-email-sweep');

SELECT cron.schedule(
  'trip-invoice-email-sweep',
  '*/5 * * * *',
  $$SELECT public.sweep_trip_invoice_emails();$$
);

COMMIT;