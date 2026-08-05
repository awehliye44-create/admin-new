-- Terminal trip payment disposition hooks (LOCAL ONLY — do not deploy until approved).
-- After trips.status becomes terminal non-completed, enqueue release-terminal-trip-hold.
-- Rematch (searching_new_driver) is never a terminal status and is not disposed.
-- Disposer is idempotent and provider-verified. Does not change fee policy or completed capture.

CREATE OR REPLACE FUNCTION public.invoke_release_terminal_trip_hold(
  p_trip_id uuid,
  p_reason text DEFAULT 'sweep_fallback'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_release_terminal_trip_hold_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/release-terminal-trip-hold'
  );
  v_token text := public.cron_edge_auth_token();
  v_cron_secret text := coalesce(
    nullif(trim(current_setting('app.settings.cron_secret', true)), ''),
    nullif(trim(current_setting('app.settings.onecab_internal_finalize_secret', true)), '')
  );
BEGIN
  IF p_trip_id IS NULL OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[invoke_release_terminal_trip_hold] aborted trip=% reason=bad_token', p_trip_id;
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
        'trip_id', p_trip_id::text,
        'reason', coalesce(nullif(trim(p_reason), ''), 'sweep_fallback'),
        'source', 'sql_terminal_hook',
        'cron_secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      ))
    );
    RAISE LOG '[invoke_release_terminal_trip_hold] enqueued trip=% reason=%', p_trip_id, p_reason;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[invoke_release_terminal_trip_hold] failed trip=% sqlerrm=%', p_trip_id, SQLERRM;
  END;
END;
$function$;

COMMENT ON FUNCTION public.invoke_release_terminal_trip_hold(uuid, text) IS
  'Fire-and-forget Edge invoke to void/fee-capture Revolut auth for a terminal non-completed trip. Safe to retry; disposer is idempotent.';

-- Trigger safety:
-- * Fires only on genuine status transition INTO an eligible terminal non-completed state
-- * Does NOT fire for completed, rematch, searching, assigned, in-progress
-- * Does NOT call Revolut (or any payment provider) from SQL
-- * Only enqueues durable Edge work via net.http_post (same pattern as sweep_revolut_stale_holds)
-- * Duplicate enqueues are safe: Edge disposer is idempotent + provider-verified
CREATE OR REPLACE FUNCTION public.trg_trips_terminal_payment_disposition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old_terminal boolean;
  v_new_eligible_terminal boolean;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Never dispose completed trips (separate settlement owner).
  IF NEW.status = 'completed' OR OLD.status = 'completed' THEN
    RETURN NEW;
  END IF;

  -- Keep auth on rematch / active statuses.
  IF NEW.status IN (
    'searching', 'searching_new_driver', 'broadcasting', 'offered', 'offering',
    'negotiating', 'pending', 'payment_pending', 'driver_assigned', 'accepted',
    'confirmed', 'queued', 'en_route', 'en_route_to_pickup', 'driver_en_route',
    'arrived', 'arrived_at_pickup', 'at_pickup', 'waiting', 'pickup_waiting',
    'in_progress', 'on_trip', 'started', 'ongoing', 'completing'
  ) THEN
    RETURN NEW;
  END IF;

  v_old_terminal := OLD.status IN (
    'cancelled', 'canceled', 'customer_cancelled', 'driver_cancelled',
    'expired', 'expired_no_driver', 'no_show', 'failed', 'declined', 'completed'
  );
  -- Already terminal: do not re-enqueue on terminal→terminal label changes.
  IF v_old_terminal THEN
    RETURN NEW;
  END IF;

  v_new_eligible_terminal := NEW.status IN (
    'cancelled', 'canceled', 'customer_cancelled', 'driver_cancelled',
    'expired', 'expired_no_driver', 'no_show', 'failed', 'declined'
  );
  IF NOT v_new_eligible_terminal THEN
    RETURN NEW;
  END IF;

  -- Enqueue only (async Edge). Provider release happens outside this transaction.
  PERFORM public.invoke_release_terminal_trip_hold(
    NEW.id,
    CASE
      WHEN NEW.status IN ('expired', 'expired_no_driver') THEN 'search_expired'
      WHEN lower(coalesce(NEW.cancelled_by, '')) = 'admin' THEN 'admin_cancel'
      WHEN lower(coalesce(NEW.cancelled_by, '')) = 'driver' THEN 'driver_cancel_terminal'
      ELSE 'customer_cancel'
    END
  );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_terminal_payment_disposition ON public.trips;
CREATE TRIGGER trg_trips_terminal_payment_disposition
AFTER UPDATE OF status ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.trg_trips_terminal_payment_disposition();

COMMENT ON TRIGGER trg_trips_terminal_payment_disposition ON public.trips IS
  'Backend-owned: after terminal non-completed status, enqueue Revolut auth disposition. Idempotent Edge disposer.';
