-- ─────────────────────────────────────────────────────────────
-- Migration A: per-service-area demand zone settings + hysteresis + audit
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.service_area_demand_zone_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid NOT NULL UNIQUE REFERENCES public.service_areas(id) ON DELETE CASCADE,

  -- Heat map
  heat_map_enabled boolean NOT NULL DEFAULT true,
  recompute_interval_minutes integer NOT NULL DEFAULT 2,
  open_trip_max_lifetime_minutes integer NOT NULL DEFAULT 6,
  zone_radius_meters integer NOT NULL DEFAULT 700,
  manual_zones_enabled boolean NOT NULL DEFAULT true,

  -- Demand thresholds (contiguous, no gaps, no overlaps)
  low_min_trips integer NOT NULL DEFAULT 1,
  low_max_trips integer NOT NULL DEFAULT 2,
  medium_min_trips integer NOT NULL DEFAULT 3,
  medium_max_trips integer NOT NULL DEFAULT 5,
  high_min_trips integer NOT NULL DEFAULT 6,
  consecutive_checks_required integer NOT NULL DEFAULT 2,

  -- Presentation only. Never affects pricing.
  colour_low text NOT NULL DEFAULT '#22C55E',
  colour_medium text NOT NULL DEFAULT '#F59E0B',
  colour_high text NOT NULL DEFAULT '#EF4444',

  -- Zone-based automatic surge (OFF by default)
  surge_enabled boolean NOT NULL DEFAULT false,
  multiplier_low numeric(4,2) NOT NULL DEFAULT 1.00,
  multiplier_medium numeric(4,2),
  multiplier_high numeric(4,2),
  max_multiplier numeric(4,2) NOT NULL DEFAULT 2.00,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,

  CONSTRAINT dz_low_range CHECK (low_min_trips >= 0 AND low_max_trips >= low_min_trips),
  CONSTRAINT dz_medium_contiguous CHECK (medium_min_trips = low_max_trips + 1),
  CONSTRAINT dz_medium_range CHECK (medium_max_trips >= medium_min_trips),
  CONSTRAINT dz_high_contiguous CHECK (high_min_trips = medium_max_trips + 1),
  CONSTRAINT dz_consecutive_checks CHECK (consecutive_checks_required >= 1),
  CONSTRAINT dz_recompute_interval CHECK (recompute_interval_minutes >= 1),
  CONSTRAINT dz_open_trip_lifetime CHECK (open_trip_max_lifetime_minutes >= 1),
  CONSTRAINT dz_zone_radius CHECK (zone_radius_meters > 0),
  CONSTRAINT dz_colour_low_hex CHECK (colour_low ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT dz_colour_medium_hex CHECK (colour_medium ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT dz_colour_high_hex CHECK (colour_high ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT dz_max_multiplier CHECK (max_multiplier >= 1.00),
  CONSTRAINT dz_multiplier_low CHECK (multiplier_low >= 1.00 AND multiplier_low <= max_multiplier),
  CONSTRAINT dz_multiplier_medium CHECK (multiplier_medium IS NULL OR (multiplier_medium >= multiplier_low AND multiplier_medium <= max_multiplier)),
  CONSTRAINT dz_multiplier_high CHECK (multiplier_high IS NULL OR (multiplier_high >= COALESCE(multiplier_medium, multiplier_low) AND multiplier_high <= max_multiplier)),
  CONSTRAINT dz_surge_requires_multipliers CHECK (
    surge_enabled = false OR (multiplier_medium IS NOT NULL AND multiplier_high IS NOT NULL)
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_area_demand_zone_settings TO authenticated;
GRANT ALL ON public.service_area_demand_zone_settings TO service_role;

ALTER TABLE public.service_area_demand_zone_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read demand zone settings"
  ON public.service_area_demand_zone_settings
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Admins write demand zone settings"
  ON public.service_area_demand_zone_settings
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER trg_demand_zone_settings_updated_at
  BEFORE UPDATE ON public.service_area_demand_zone_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed safe defaults (surge OFF) for every existing service area
INSERT INTO public.service_area_demand_zone_settings (service_area_id)
SELECT sa.id FROM public.service_areas sa
ON CONFLICT (service_area_id) DO NOTHING;

-- ─── Hysteresis + evaluation state on existing zones ───

ALTER TABLE public.driver_demand_zones
  ADD COLUMN IF NOT EXISTS proposed_demand_level text,
  ADD COLUMN IF NOT EXISTS confirmed_demand_level text,
  ADD COLUMN IF NOT EXISTS consecutive_match_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_open_trip_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS level_changed_at timestamptz;

UPDATE public.driver_demand_zones
SET confirmed_demand_level = COALESCE(confirmed_demand_level, demand_level)
WHERE confirmed_demand_level IS NULL;

ALTER TABLE public.driver_demand_zones
  ALTER COLUMN confirmed_demand_level SET DEFAULT 'LOW';

ALTER TABLE public.driver_demand_zones
  ADD CONSTRAINT dz_confirmed_level_valid
  CHECK (confirmed_demand_level IS NULL OR confirmed_demand_level IN ('LOW','MEDIUM','HIGH'));

ALTER TABLE public.driver_demand_zones
  ADD CONSTRAINT dz_proposed_level_valid
  CHECK (proposed_demand_level IS NULL OR proposed_demand_level IN ('LOW','MEDIUM','HIGH'));

CREATE INDEX IF NOT EXISTS idx_driver_demand_zones_sa_active
  ON public.driver_demand_zones (service_area_id, active) WHERE active = true;

-- ─── Audit log ───

CREATE TABLE IF NOT EXISTS public.demand_zone_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  zone_id uuid,
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  field_key text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.demand_zone_audit_log TO authenticated;
GRANT ALL ON public.demand_zone_audit_log TO service_role;

ALTER TABLE public.demand_zone_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read demand zone audit log"
  ON public.demand_zone_audit_log
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE INDEX IF NOT EXISTS idx_demand_zone_audit_sa_created
  ON public.demand_zone_audit_log (service_area_id, created_at DESC);