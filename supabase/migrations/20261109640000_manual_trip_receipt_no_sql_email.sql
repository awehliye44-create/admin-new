-- SQL must not ask the invoice function to email.
-- generate / send / resend from the database are stored as generate_only.

CREATE OR REPLACE FUNCTION public.invoke_trip_invoice_process(
  p_trip_id uuid,
  p_action text DEFAULT 'generate_only'
)
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
  v_action text := lower(trim(coalesce(p_action, '')));
BEGIN
  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[trip-invoice] aborted reason=bad_token trip=%', p_trip_id;
    RETURN;
  END IF;

  -- Completion and cron may store a PDF. They must not email.
  IF v_action IN ('', 'generate', 'auto', 'send', 'send_email', 'resend', 'resend_email') THEN
    v_action := 'generate_only';
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token
      ),
      body := jsonb_build_object('trip_id', p_trip_id, 'action', v_action, 'source', 'store_only')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[trip-invoice] invoke_failed trip=% sqlerrm=%', p_trip_id, SQLERRM;
  END;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.invoke_trip_invoice_process(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_trip_invoice_process(uuid, text) TO service_role;
