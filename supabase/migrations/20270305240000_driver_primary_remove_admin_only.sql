-- Primary selection and saved-vehicle removal are Admin-only.
-- Drivers may list saved vehicles (read-only); EXECUTE on mutate RPCs
-- is revoked from authenticated. List flags can_set_primary / can_remove
-- are always false so clients never paint action affordances.

CREATE OR REPLACE FUNCTION public.list_driver_saved_vehicles()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT d.id INTO v_driver_id FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'vehicles', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('ok', true, 'vehicles', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', v.id,
      'make', v.make,
      'model', v.model,
      'year', v.year,
      'colour', v.color,
      'licence_plate', v.license_plate,
      'approval_status', v.approval_status,
      'is_primary', COALESCE(v.is_primary, false),
      'is_trip_active', COALESCE(v.is_trip_active, false),
      'operational_status', v.operational_status,
      'fleet_shared', COALESCE(v.fleet_shared, false),
      'can_set_primary', false,
      'can_remove', false
    ) ORDER BY v.is_trip_active DESC, v.is_primary DESC, v.created_at ASC)
      FROM public.vehicles v
     WHERE v.driver_id = v_driver_id
       AND COALESCE(v.operational_status, 'active') NOT IN ('available_in_fleet', 'archived')
  ), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.list_driver_saved_vehicles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_driver_saved_vehicles() TO authenticated, service_role;

-- Keep function bodies for service_role / internal use; drivers cannot call them.
REVOKE ALL ON FUNCTION public.set_driver_primary_vehicle(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_driver_primary_vehicle(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.remove_driver_saved_vehicle(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_driver_saved_vehicle(uuid) TO service_role;
