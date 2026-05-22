
CREATE TABLE IF NOT EXISTS public.global_dispatch_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  -- dispatch
  driver_response_timeout_seconds integer NOT NULL DEFAULT 180,
  start_radius_meters integer NOT NULL DEFAULT 4000,
  expand_radius_meters integer NOT NULL DEFAULT 8000,
  max_radius_meters integer NOT NULL DEFAULT 13000,
  drivers_per_wave integer NOT NULL DEFAULT 3,
  wave_delay_seconds integer NOT NULL DEFAULT 15,
  dispatch_mode text NOT NULL DEFAULT 'smart_score',
  -- stacked rides
  stacked_rides_enabled boolean NOT NULL DEFAULT true,
  max_active_rides_per_driver integer NOT NULL DEFAULT 2,
  allow_same_direction_only boolean NOT NULL DEFAULT true,
  allow_new_ride_while_driver_active boolean NOT NULL DEFAULT true,
  max_pickup_detour_meters integer NOT NULL DEFAULT 3000,
  max_dropoff_detour_meters integer NOT NULL DEFAULT 5000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT singleton_must_be_true CHECK (singleton = true),
  CONSTRAINT valid_radii CHECK (
    start_radius_meters > 0
    AND expand_radius_meters >= start_radius_meters
    AND max_radius_meters >= expand_radius_meters
  ),
  CONSTRAINT valid_timeout CHECK (
    driver_response_timeout_seconds >= 60
    AND driver_response_timeout_seconds <= 900
  ),
  CONSTRAINT valid_wave CHECK (drivers_per_wave >= 1 AND wave_delay_seconds >= 0),
  CONSTRAINT valid_stacked CHECK (
    max_active_rides_per_driver BETWEEN 1 AND 5
    AND max_pickup_detour_meters > 0
    AND max_dropoff_detour_meters > 0
  )
);

ALTER TABLE public.global_dispatch_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view global dispatch settings"
  ON public.global_dispatch_settings FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Admins manage global dispatch settings"
  ON public.global_dispatch_settings FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER update_global_dispatch_settings_updated_at
  BEFORE UPDATE ON public.global_dispatch_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default singleton row
INSERT INTO public.global_dispatch_settings (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
