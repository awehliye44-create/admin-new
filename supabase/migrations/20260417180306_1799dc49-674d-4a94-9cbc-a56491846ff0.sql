-- Per-vehicle-category zone route pricing
-- Adds surcharge + airport fee fields and enforces unique row per (from, to, service_area, vehicle_type)

ALTER TABLE public.zone_route_pricing
  ADD COLUMN IF NOT EXISTS surcharge_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS airport_pickup_fee numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS airport_dropoff_fee numeric NOT NULL DEFAULT 0;

-- Uniqueness: one row per route × vehicle category × service area scope.
-- NULL vehicle_type_id = explicit fallback; NULL service_area_id = applies anywhere.
-- Use coalesce to make uniqueness work across NULLs.
CREATE UNIQUE INDEX IF NOT EXISTS zone_route_pricing_unique_combo
  ON public.zone_route_pricing (
    from_zone_id,
    to_zone_id,
    COALESCE(service_area_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(vehicle_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS zone_route_pricing_lookup_idx
  ON public.zone_route_pricing (from_zone_id, to_zone_id, is_active, vehicle_type_id);

COMMENT ON COLUMN public.zone_route_pricing.vehicle_type_id IS 'NULL = explicit fallback row applied only when no category-specific row exists.';
COMMENT ON COLUMN public.zone_route_pricing.surcharge_pct IS 'Percentage surcharge added on top of fixed_fare (0-100).';