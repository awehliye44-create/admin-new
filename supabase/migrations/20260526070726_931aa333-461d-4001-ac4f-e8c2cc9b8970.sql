
-- 1. Add the three new fields to service_area_vehicle_pricing
ALTER TABLE public.service_area_vehicle_pricing
  ADD COLUMN IF NOT EXISTS per_km_rate_pence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS per_min_rate_pence integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS airport_charge_pence integer NOT NULL DEFAULT 0;

-- 2. Backfill per_km / per_min from first JSONB tier (rates stored as decimal currency units)
UPDATE public.service_area_vehicle_pricing
SET per_km_rate_pence = COALESCE(
      ROUND((distance_pricing -> 0 ->> 'rate')::numeric * 100)::integer,
      0
    ),
    per_min_rate_pence = COALESCE(
      ROUND((time_pricing -> 0 ->> 'rate')::numeric * 100)::integer,
      0
    )
WHERE per_km_rate_pence = 0 OR per_min_rate_pence = 0;

-- 3. Mirror trigger: keep fare_pricing_settings per-vehicle row in sync with SOT
CREATE OR REPLACE FUNCTION public.sync_sav_pricing_to_fare_engine()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_pence integer := COALESCE(ROUND(NEW.base_fare * 100)::integer, 0);
  v_min_pence  integer := COALESCE(ROUND(NEW.minimum_fare * 100)::integer, 0);
BEGIN
  -- Upsert the vehicle-scoped row in fare_pricing_settings
  INSERT INTO public.fare_pricing_settings (
    service_area_id, vehicle_type_id,
    pricing_mode, currency_code,
    base_fare_pence, per_km_rate_pence, per_min_rate_pence,
    minimum_fare_pence, booking_fee_pence
  )
  VALUES (
    NEW.service_area_id, NEW.vehicle_type_id,
    'fixed', NEW.currency_code,
    v_base_pence, NEW.per_km_rate_pence, NEW.per_min_rate_pence,
    v_min_pence, 0
  )
  ON CONFLICT (service_area_id, vehicle_type_id) DO UPDATE
  SET base_fare_pence    = EXCLUDED.base_fare_pence,
      per_km_rate_pence  = EXCLUDED.per_km_rate_pence,
      per_min_rate_pence = EXCLUDED.per_min_rate_pence,
      minimum_fare_pence = EXCLUDED.minimum_fare_pence,
      currency_code      = EXCLUDED.currency_code,
      updated_at         = now();

  RETURN NEW;
END;
$$;

-- 3a. fare_pricing_settings needs a unique constraint for the ON CONFLICT target
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fare_pricing_settings_sa_vt_unique'
  ) THEN
    -- Drop NULL rows that would conflict with a NOT NULL unique on (sa, vt)
    -- Use a partial unique index instead to allow NULL vehicle_type_id (default config)
    CREATE UNIQUE INDEX fare_pricing_settings_sa_vt_unique
      ON public.fare_pricing_settings (service_area_id, vehicle_type_id)
      WHERE vehicle_type_id IS NOT NULL;
    CREATE UNIQUE INDEX fare_pricing_settings_sa_default_unique
      ON public.fare_pricing_settings (service_area_id)
      WHERE vehicle_type_id IS NULL;
  END IF;
END $$;

-- Re-create function with index-based conflict target
CREATE OR REPLACE FUNCTION public.sync_sav_pricing_to_fare_engine()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_pence integer := COALESCE(ROUND(NEW.base_fare * 100)::integer, 0);
  v_min_pence  integer := COALESCE(ROUND(NEW.minimum_fare * 100)::integer, 0);
  v_existing_id uuid;
BEGIN
  SELECT id INTO v_existing_id
  FROM public.fare_pricing_settings
  WHERE service_area_id = NEW.service_area_id
    AND vehicle_type_id = NEW.vehicle_type_id;

  IF v_existing_id IS NULL THEN
    INSERT INTO public.fare_pricing_settings (
      service_area_id, vehicle_type_id,
      pricing_mode, currency_code,
      base_fare_pence, per_km_rate_pence, per_min_rate_pence,
      minimum_fare_pence, booking_fee_pence
    )
    VALUES (
      NEW.service_area_id, NEW.vehicle_type_id,
      'fixed', NEW.currency_code,
      v_base_pence, NEW.per_km_rate_pence, NEW.per_min_rate_pence,
      v_min_pence, 0
    );
  ELSE
    UPDATE public.fare_pricing_settings
    SET base_fare_pence    = v_base_pence,
        per_km_rate_pence  = NEW.per_km_rate_pence,
        per_min_rate_pence = NEW.per_min_rate_pence,
        minimum_fare_pence = v_min_pence,
        currency_code      = NEW.currency_code,
        updated_at         = now()
    WHERE id = v_existing_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_sav_pricing_to_fare_engine ON public.service_area_vehicle_pricing;
CREATE TRIGGER trg_sync_sav_pricing_to_fare_engine
AFTER INSERT OR UPDATE OF base_fare, minimum_fare, per_km_rate_pence, per_min_rate_pence, currency_code
ON public.service_area_vehicle_pricing
FOR EACH ROW
EXECUTE FUNCTION public.sync_sav_pricing_to_fare_engine();

-- 4. Backfill: trigger the sync for every existing row by touching updated_at
UPDATE public.service_area_vehicle_pricing
SET updated_at = now();

-- 5. Normalise custom_zones.zone_type for airport detection (lowercase trim)
UPDATE public.custom_zones
SET zone_type = lower(trim(zone_type))
WHERE zone_type IS NOT NULL
  AND zone_type <> lower(trim(zone_type));

-- 6. Drop unused custom_zones.airport_fee column (never read by any code path).
--    Airport charges are now per-vehicle on service_area_vehicle_pricing.airport_charge_pence
ALTER TABLE public.custom_zones
  DROP COLUMN IF EXISTS airport_fee;
