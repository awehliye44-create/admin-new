
-- ===========================
-- 1. FARE PRICING SETTINGS TABLE (per service area)
-- ===========================
CREATE TABLE public.fare_pricing_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE CASCADE NOT NULL,
  
  -- General
  pricing_mode text NOT NULL DEFAULT 'fixed' CHECK (pricing_mode IN ('fixed', 'dynamic')),
  currency_code text NOT NULL DEFAULT 'GBP',
  
  -- Fixed pricing rates (stored in pence)
  base_fare_pence integer NOT NULL DEFAULT 300,
  per_km_rate_pence integer NOT NULL DEFAULT 150,
  per_min_rate_pence integer NOT NULL DEFAULT 20,
  booking_fee_pence integer NOT NULL DEFAULT 100,
  minimum_fare_pence integer NOT NULL DEFAULT 500,
  
  -- Waiting
  free_waiting_minutes integer NOT NULL DEFAULT 3,
  waiting_per_minute_pence integer NOT NULL DEFAULT 30,
  
  -- Stop charges
  extra_stop_flat_fee_pence integer NOT NULL DEFAULT 200,
  
  -- Recalculation rules
  recalculate_on_waiting boolean NOT NULL DEFAULT true,
  recalculate_on_stop_added boolean NOT NULL DEFAULT true,
  recalculate_on_dropoff_changed boolean NOT NULL DEFAULT true,
  
  -- Dynamic pricing (disabled by default)
  enable_surge boolean NOT NULL DEFAULT false,
  surge_multiplier_default numeric(4,2) NOT NULL DEFAULT 1.00,
  peak_hour_multiplier numeric(4,2) NOT NULL DEFAULT 1.00,
  zone_multiplier numeric(4,2) NOT NULL DEFAULT 1.00,
  traffic_multiplier numeric(4,2) NOT NULL DEFAULT 1.00,
  demand_supply_multiplier numeric(4,2) NOT NULL DEFAULT 1.00,
  
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(service_area_id)
);

ALTER TABLE public.fare_pricing_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage fare pricing settings"
ON public.fare_pricing_settings
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated users can read fare pricing settings"
ON public.fare_pricing_settings
FOR SELECT
TO authenticated
USING (true);

-- ===========================
-- 2. FARE AUDIT LOG TABLE
-- ===========================
CREATE TABLE public.fare_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid REFERENCES public.trips(id) ON DELETE CASCADE NOT NULL,
  event_type text NOT NULL,
  old_fare_pence integer,
  adjustment_pence integer,
  new_fare_pence integer,
  reason text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.fare_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage fare audit logs"
ON public.fare_audit_logs
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Authenticated read fare audit logs"
ON public.fare_audit_logs
FOR SELECT
TO authenticated
USING (true);

-- ===========================
-- 3. ADD FARE TRACKING COLUMNS TO TRIPS
-- ===========================
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS pricing_mode text DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS quoted_fare_pence integer,
  ADD COLUMN IF NOT EXISTS waiting_minutes numeric(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS waiting_charge_pence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_charge_total_pence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS destination_change_adjustment_pence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fare_breakdown jsonb DEFAULT '{}';

-- ===========================
-- 4. TRIGGERS
-- ===========================
CREATE TRIGGER update_fare_pricing_settings_updated_at
  BEFORE UPDATE ON public.fare_pricing_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
