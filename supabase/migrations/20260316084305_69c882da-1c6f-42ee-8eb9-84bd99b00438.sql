
-- Create a view for drivers to see only their assigned vehicle types
CREATE OR REPLACE VIEW public.driver_assigned_vehicle_types
WITH (security_invoker = on) AS
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
  vt.is_active
FROM public.driver_vehicle_categories dvc
JOIN public.vehicle_types vt ON vt.id = dvc.vehicle_type_id
WHERE vt.is_active = true;
