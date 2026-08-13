-- P0 #2 follow-up: never invent max waiting 15; persist waiting provenance on freeze.
-- Forward-only. Does not re-apply 2026080821* / 20260920120000.

CREATE OR REPLACE FUNCTION public.persist_pickup_waiting_admin_ssot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_free_minutes numeric := NULL;
  v_free_seconds integer := 0;
  v_paid_enabled boolean := false;
  v_fare_paid boolean := NULL;
  v_fare_rate integer := NULL;
  v_dispatch_rate integer := NULL;
  v_rate integer := 0;
  v_interval integer := NULL;
  v_max_minutes integer := NULL;
  v_grace_source text := 'fare_pricing';
  v_no_show_minutes numeric := NULL;
  v_cfg jsonb;
  v_existing_source text;
  v_config_available boolean := false;
BEGIN
  IF NEW.pickup_waiting_started_at IS NULL OR NEW.service_area_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Never reset started_at on repeated Arrived / updates.
  IF TG_OP = 'UPDATE'
     AND OLD.pickup_waiting_started_at IS NOT NULL
     AND NEW.pickup_waiting_started_at IS DISTINCT FROM OLD.pickup_waiting_started_at
  THEN
    NEW.pickup_waiting_started_at := OLD.pickup_waiting_started_at;
  END IF;

  v_existing_source := COALESCE(NEW.pickup_waiting_admin_config->>'pickup_grace_source', '');

  -- Skip when already frozen from fare_pricing with expires_at present.
  IF NEW.free_wait_expires_at IS NOT NULL
     AND NEW.pickup_waiting_admin_config IS NOT NULL
     AND v_existing_source = 'fare_pricing'
     AND (
       TG_OP = 'INSERT'
       OR OLD.pickup_waiting_started_at IS NOT DISTINCT FROM NEW.pickup_waiting_started_at
     )
  THEN
    -- Still ensure provenance keys exist without rewriting money SSOT.
    NEW.pickup_waiting_admin_config := COALESCE(NEW.pickup_waiting_admin_config, '{}'::jsonb) || jsonb_build_object(
      'waiting_context', COALESCE(NEW.pickup_waiting_admin_config->>'waiting_context', 'pickup'),
      'driver_id', COALESCE(NEW.pickup_waiting_admin_config->>'driver_id', NEW.driver_id::text),
      'trip_id', COALESCE(NEW.pickup_waiting_admin_config->>'trip_id', NEW.id::text),
      'service_area_id', COALESCE(NEW.pickup_waiting_admin_config->>'service_area_id', NEW.service_area_id::text),
      'vehicle_type_id', COALESCE(
        NEW.pickup_waiting_admin_config->>'vehicle_type_id',
        NEW.vehicle_type_id::text
      ),
      'frozen_at', COALESCE(
        NEW.pickup_waiting_admin_config->>'frozen_at',
        NEW.pickup_waiting_started_at::text
      )
    );
    RETURN NEW;
  END IF;

  SELECT fps.free_waiting_minutes,
         COALESCE(fps.pickup_paid_waiting_enabled, fps.recalculate_on_waiting),
         fps.waiting_per_minute_pence,
         fps.no_show_wait_time_minutes
  INTO v_free_minutes, v_fare_paid, v_fare_rate, v_no_show_minutes
  FROM public.fare_pricing_settings fps
  WHERE fps.service_area_id = NEW.service_area_id
    AND (fps.vehicle_type_id = NEW.vehicle_type_id OR fps.vehicle_type_id IS NULL)
  ORDER BY CASE WHEN fps.vehicle_type_id IS NOT DISTINCT FROM NEW.vehicle_type_id THEN 0 ELSE 1 END,
           fps.updated_at DESC NULLS LAST
  LIMIT 1;

  SELECT ds.pickup_waiting_grace_period_seconds,
         ds.pickup_paid_waiting_enabled,
         ds.pickup_paid_waiting_rate_pence_per_minute,
         ds.pickup_waiting_max_minutes,
         ds.stop_waiting_charge_interval_seconds
  INTO v_free_seconds, v_paid_enabled, v_dispatch_rate, v_max_minutes, v_interval
  FROM public.dispatch_settings ds
  WHERE ds.service_area_id = NEW.service_area_id
  LIMIT 1;
  -- No global dispatch fallback when SA known.

  IF v_free_minutes IS NOT NULL THEN
    v_grace_source := 'fare_pricing';
    v_free_seconds := GREATEST(0, ROUND(v_free_minutes * 60)::int);
    v_paid_enabled := COALESCE(v_fare_paid, v_paid_enabled, false);
    v_config_available := true;
  ELSIF v_free_seconds IS NOT NULL THEN
    v_grace_source := 'dispatch';
    v_free_seconds := GREATEST(0, COALESCE(v_free_seconds, 0));
    v_free_minutes := v_free_seconds / 60.0;
    v_paid_enabled := COALESCE(v_paid_enabled, false);
    v_config_available := true;
  ELSE
    v_grace_source := 'unavailable';
    v_free_seconds := 0;
    v_free_minutes := 0;
    v_paid_enabled := false;
    v_config_available := false;
  END IF;

  -- Fare vehicle-specific rate wins; dispatch is fallback only.
  v_rate := COALESCE(v_fare_rate, v_dispatch_rate, 0);
  -- Never invent max minutes (was COALESCE(..., 15) — MK Admin max is NULL = uncapped).
  v_max_minutes := COALESCE(v_max_minutes, 0);
  v_no_show_minutes := COALESCE(v_no_show_minutes, v_free_minutes, 0);
  v_interval := COALESCE(v_interval, 0);

  v_cfg := jsonb_build_object(
    'free_pickup_waiting_minutes', COALESCE(v_free_minutes, 0),
    'free_pickup_waiting_seconds', v_free_seconds,
    'pickup_grace_source', v_grace_source,
    'no_show_waiting_minutes', v_no_show_minutes,
    'no_show_waiting_seconds', GREATEST(0, ROUND(v_no_show_minutes * 60)::int),
    'pickup_paid_waiting_enabled', COALESCE(v_paid_enabled, false),
    'pickup_paid_waiting_rate_pence_per_minute', v_rate,
    'pickup_waiting_max_minutes', v_max_minutes,
    'waiting_charge_interval_seconds', v_interval,
    'waiting_charge_interval_source', CASE WHEN v_interval > 0 THEN 'dispatch_settings' ELSE 'unavailable' END,
    'waiting_charge_rounding', 'completed_intervals',
    'config_available', v_config_available,
    'waiting_context', 'pickup',
    'service_area_id', NEW.service_area_id,
    'vehicle_type_id', NEW.vehicle_type_id,
    'trip_id', NEW.id,
    'driver_id', NEW.driver_id,
    'frozen_at', NEW.pickup_waiting_started_at
  );

  NEW.pickup_waiting_admin_config := COALESCE(NEW.pickup_waiting_admin_config, '{}'::jsonb) || v_cfg;
  NEW.free_wait_expires_at := NEW.pickup_waiting_started_at + make_interval(secs => v_free_seconds);

  RETURN NEW;
END;
$$;
