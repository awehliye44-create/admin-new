-- My Documents / Home documents fetch crashed after vehicle replacement SSOT:
-- driver_document_compliance_ssot calls resolve_trip_active_vehicle_id, but
-- 20270305100000 revoked EXECUTE from authenticated → PostgREST
-- "permission denied for function resolve_trip_active_vehicle_id" →
-- Driver app shows "Documents could not be loaded."
--
-- Restore authenticated EXECUTE (required for the view) and clamp JWT drivers
-- to their own id so callers cannot resolve another driver's trip-active vehicle.
-- Staff/service (no current_driver_id) may still pass any driver id.

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_trip_active_vehicle_id(p_driver_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid;
BEGIN
  v_caller := public.current_driver_id();
  IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_driver_id THEN
    RETURN NULL;
  END IF;

  RETURN (
    SELECT v.id
      FROM public.vehicles v
     WHERE v.driver_id = p_driver_id
       AND v.is_trip_active = true
     ORDER BY v.updated_at DESC
     LIMIT 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_trip_active_vehicle_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_trip_active_vehicle_id(uuid) TO authenticated, service_role;

COMMIT;
