-- =====================================================================
-- Fix 1: Add EXISTS guard to ack_timeout_sweep so it skips the Edge
-- Function enqueue when there is no pending ACK-timeout work.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.ack_timeout_sweep()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_ack_timeout_sweep_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/ack-timeout-sweep'
  );
  v_token text := coalesce(
    nullif(trim(current_setting('app.settings.service_role_key', true)), ''),
    nullif(trim(current_setting('supabase.service_role_key', true)), ''),
    nullif(trim(current_setting('app.settings.supabase_anon_key', true)), ''),
    nullif(trim(current_setting('SUPABASE_ANON_KEY', true)), ''),
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz-1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM'
  );
BEGIN
  -- Guard: exit immediately when there is no pending ACK-timeout work.
  -- "Pending ACK timeout" = ride_offers that are still pending, have never
  -- been acknowledged, and whose expires_at is in the past.
  IF NOT EXISTS (
    SELECT 1
    FROM public.ride_offers
    WHERE status = 'pending'
      AND ack_at IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= now()
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RAISE LOG '[delivery] ack_timeout_sweep aborted reason=bad_url';
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
      body := '{}'::jsonb
    );
    RAISE LOG '[delivery] ack_timeout_sweep edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[delivery] ack_timeout_sweep edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
  END;
END;
$function$;

-- =====================================================================
-- Fix 2: Reschedule cron job "ack-timeout-sweep" from 5s → 10s.
-- cron.schedule() with an existing jobname performs an upsert and
-- preserves the same jobid (22).
-- =====================================================================
SELECT cron.schedule(
  'ack-timeout-sweep',
  '10 seconds',
  $$SELECT public.ack_timeout_sweep();$$
);

-- =====================================================================
-- ROLLBACK (run manually to restore prior behaviour):
-- ---------------------------------------------------------------------
-- -- Restore 5-second cadence:
-- SELECT cron.schedule(
--   'ack-timeout-sweep',
--   '5 seconds',
--   $$SELECT public.ack_timeout_sweep();$$
-- );
--
-- -- Restore prior function body (no EXISTS guard):
-- CREATE OR REPLACE FUNCTION public.ack_timeout_sweep()
--  RETURNS void
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'public'
-- AS $function$
-- DECLARE
--   v_url text := coalesce(
--     nullif(trim(current_setting('app.settings.edge_ack_timeout_sweep_url', true)), ''),
--     'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/ack-timeout-sweep'
--   );
--   v_token text := coalesce(
--     nullif(trim(current_setting('app.settings.service_role_key', true)), ''),
--     nullif(trim(current_setting('supabase.service_role_key', true)), ''),
--     nullif(trim(current_setting('app.settings.supabase_anon_key', true)), ''),
--     nullif(trim(current_setting('SUPABASE_ANON_KEY', true)), ''),
--     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz-1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM'
--   );
-- BEGIN
--   IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
--     RAISE LOG '[delivery] ack_timeout_sweep aborted reason=bad_url';
--     RETURN;
--   END IF;
--   BEGIN
--     PERFORM net.http_post(
--       url := v_url,
--       headers := jsonb_build_object(
--         'Content-Type', 'application/json',
--         'Authorization', 'Bearer ' || v_token,
--         'apikey', v_token
--       ),
--       body := '{}'::jsonb
--     );
--   EXCEPTION WHEN OTHERS THEN
--     RAISE LOG '[delivery] ack_timeout_sweep edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
--   END;
-- END;
-- $function$;
-- =====================================================================
