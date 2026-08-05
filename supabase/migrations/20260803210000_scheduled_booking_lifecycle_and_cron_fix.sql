-- Scheduled booking marketplace + cron routing fix (MK-260803-008 audit).
--
-- Root causes verified live:
-- 1) Create paths left is_scheduled trips as status=searching +
--    dispatch_mode=instant (column default) → instant search expiry, never listed
--    by list_driver_own_scheduled_jobs (requires dispatch_mode='scheduled' and
--    scheduled_status IN broadcasting|scheduled|awaiting_confirmation).
-- 2) Live cron job "scheduled-dispatch-every-minute" still POSTed to obsolete
--    Edge URL .../scheduled-dispatch (404). Correct function is schedule-dispatch.
--
-- Safety: do NOT rewrite finalize_paid_booking_session body here — a BEFORE
-- INSERT trigger covers finalize + create-trip-after-payment + admin inserts.

-- ─────────────────────────────────────────────────────────────
-- A) BEFORE INSERT: enforce scheduled lifecycle for EVERY create path
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_scheduled_trip_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_scheduled boolean;
  v_terminal boolean;
BEGIN
  v_is_scheduled :=
    COALESCE(NEW.is_scheduled, false)
    OR LOWER(COALESCE(NEW.trip_type, '')) = 'scheduled'
    OR NEW.scheduled_at IS NOT NULL;

  IF NOT v_is_scheduled OR NEW.scheduled_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_terminal := LOWER(COALESCE(NEW.status, '')) IN (
    'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
    'no_show', 'expired', 'expired_no_driver'
  );

  NEW.is_scheduled := true;
  IF NEW.trip_type IS NULL OR btrim(NEW.trip_type) = '' OR LOWER(NEW.trip_type) = 'instant' THEN
    NEW.trip_type := 'scheduled';
  END IF;
  NEW.dispatch_mode := 'scheduled';

  IF NOT v_terminal THEN
    NEW.status := 'scheduled';
  END IF;

  -- Open marketplace pool when unassigned and status not already advanced.
  IF NEW.confirmed_driver_id IS NULL
     AND NEW.driver_id IS NULL
     AND (
       NEW.scheduled_status IS NULL
       OR btrim(NEW.scheduled_status) = ''
       OR LOWER(NEW.scheduled_status) IN ('pending', 'searching')
     )
  THEN
    NEW.scheduled_status := 'broadcasting';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_scheduled_trip_lifecycle ON public.trips;
CREATE TRIGGER trg_enforce_scheduled_trip_lifecycle
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_scheduled_trip_lifecycle();

-- ─────────────────────────────────────────────────────────────
-- B) Cron: unsched obsolete scheduled-dispatch URL; schedule schedule-dispatch
-- ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'scheduled-dispatch-every-minute') THEN
    PERFORM cron.unschedule('scheduled-dispatch-every-minute');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'schedule-dispatch-every-minute') THEN
    PERFORM cron.unschedule('schedule-dispatch-every-minute');
  END IF;
END $$;

SELECT cron.schedule(
  'schedule-dispatch-every-minute',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/schedule-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || public.cron_edge_auth_token(),
      'apikey', public.cron_edge_auth_token()
    ),
    body := '{}'::jsonb
  );
  $cron$
);
