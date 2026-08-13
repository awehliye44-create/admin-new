-- Restored from live schema_migrations.statements (already applied). Do not re-run.
-- SUPERSEDED for rate precedence by 20260920120000_p0_pickup_waiting_admin_ssot_charge_interval
-- (fare rate must win: COALESCE(v_fare_rate, v_dispatch_rate, 0)).

-- DB SSOT guard: when pickup waiting starts (or a poisoned dispatch snapshot lands),
-- freeze Admin Trip Lifecycle free-wait + paid flags and free_wait_expires_at.
-- Never leave apps on the global dispatch row (historically 300s + paid OFF).

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
  v_fare_rate integer := NULL;
  v_dispatch_rate integer := NULL;
  v_rate integer := 0;
  v_interval integer := NULL;
  v_max_minutes integer := 15;
  v_grace_source text := 'fare_pricing';
  v_no_show_minutes numeric := NULL;
  v_cfg jsonb;
  v_existing_source text;
BEGIN
  IF NEW.pickup_waiting_started_at IS NULL OR NEW.service_area_id IS NULL THEN
    RETURN NEW;
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
    RETURN NEW;
  END IF;

  SELECT fps.free_waiting_minutes,
         fps.pickup_paid_waiting_enabled,
         fps.waiting_per_minute_pence,
         fps.no_show_wait_time_minutes
  INTO v_free_minutes, v_paid_enabled, v_fare_rate, v_no_show_minutes
  FROM public.fare_pricing_settings fps
  WHERE fps.service_area_id = NEW.service_area_id
    AND (fps.vehicle_type_id = NEW.vehicle_type_id OR fps.vehicle_type_id IS NULL)
  ORDER BY CASE WHEN fps.vehicle_type_id = NEW.vehicle_type_id THEN 0 ELSE 1 END
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

  IF v_free_minutes IS NOT NULL THEN
    v_grace_source := 'fare_pricing';
    v_free_seconds := GREATEST(0, ROUND(v_free_minutes * 60)::int);
    -- Trip Lifecycle paid flag wins when present.
    SELECT COALESCE(fps.pickup_paid_waiting_enabled, v_paid_enabled, false)
    INTO v_paid_enabled
    FROM public.fare_pricing_settings fps
    WHERE fps.service_area_id = NEW.service_area_id
      AND (fps.vehicle_type_id = NEW.vehicle_type_id OR fps.vehicle_type_id IS NULL)
    ORDER BY CASE WHEN fps.vehicle_type_id = NEW.vehicle_type_id THEN 0 ELSE 1 END
    LIMIT 1;
  ELSE
    v_grace_source := 'dispatch';
    v_free_seconds := GREATEST(0, COALESCE(v_free_seconds, 0));
    v_free_minutes := v_free_seconds / 60.0;
    v_paid_enabled := COALESCE(v_paid_enabled, false);
  END IF;

  v_rate := COALESCE(v_dispatch_rate, v_fare_rate, 0);
  v_max_minutes := COALESCE(v_max_minutes, 15);
  v_no_show_minutes := COALESCE(v_no_show_minutes, v_free_minutes, 0);

  v_cfg := jsonb_build_object(
    'free_pickup_waiting_minutes', COALESCE(v_free_minutes, 0),
    'free_pickup_waiting_seconds', v_free_seconds,
    'pickup_grace_source', v_grace_source,
    'no_show_waiting_minutes', v_no_show_minutes,
    'no_show_waiting_seconds', GREATEST(0, ROUND(v_no_show_minutes * 60)::int),
    'pickup_paid_waiting_enabled', COALESCE(v_paid_enabled, false),
    'pickup_paid_waiting_rate_pence_per_minute', v_rate,
    'pickup_waiting_max_minutes', v_max_minutes,
    'waiting_charge_interval_seconds', v_interval
  );

  NEW.pickup_waiting_admin_config := COALESCE(NEW.pickup_waiting_admin_config, '{}'::jsonb) || v_cfg;
  NEW.free_wait_expires_at := NEW.pickup_waiting_started_at + make_interval(secs => v_free_seconds);

  RETURN NEW;
END;
$$


DROP TRIGGER IF EXISTS trg_persist_pickup_waiting_admin_ssot ON public.trips


CREATE TRIGGER trg_persist_pickup_waiting_admin_ssot
BEFORE INSERT OR UPDATE OF pickup_waiting_started_at, pickup_waiting_admin_config, free_wait_expires_at
ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.persist_pickup_waiting_admin_ssot()


