
-- Add is_default and driver_controllable columns to vehicle_types
ALTER TABLE public.vehicle_types
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_controllable boolean NOT NULL DEFAULT false;

-- Mark ONECAB as the default category (match by slug)
UPDATE public.vehicle_types
SET is_default = true
WHERE slug = 'onecab';

-- Recreate the driver_assigned_vehicle_types view
-- Logic: ONECAB (is_default) always visible + admin-assigned categories
CREATE OR REPLACE VIEW public.driver_assigned_vehicle_types
WITH (security_invoker = on) AS
-- Admin-assigned categories
SELECT 
  dvc.id as assignment_id,
  dvc.driver_id,
  dvc.is_enabled,
  dvc.created_at as assigned_at,
  vt.id as vehicle_type_id,
  vt.name,
  vt.slug,
  vt.description,
  vt.icon,
  vt.display_order,
  vt.capacity,
  vt.categories,
  vt.features,
  vt.is_active,
  vt.is_default,
  vt.driver_controllable
FROM public.driver_vehicle_categories dvc
JOIN public.vehicle_types vt ON vt.id = dvc.vehicle_type_id
WHERE vt.is_active = true
  AND vt.is_default = false

UNION ALL

-- Default categories (ONECAB) - always visible for every driver
SELECT 
  NULL::uuid as assignment_id,
  d.id as driver_id,
  true as is_enabled,
  d.created_at as assigned_at,
  vt.id as vehicle_type_id,
  vt.name,
  vt.slug,
  vt.description,
  vt.icon,
  vt.display_order,
  vt.capacity,
  vt.categories,
  vt.features,
  vt.is_active,
  vt.is_default,
  vt.driver_controllable
FROM public.vehicle_types vt
CROSS JOIN public.drivers d
WHERE vt.is_active = true
  AND vt.is_default = true;
