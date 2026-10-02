ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid;

CREATE OR REPLACE FUNCTION public.admin_remove_service_area(p_service_area_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live_drivers int;
  v_open_trips int;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM service_areas WHERE id = p_service_area_id) THEN
    RAISE EXCEPTION 'SERVICE_AREA_NOT_FOUND';
  END IF;

  SELECT count(*) INTO v_live_drivers FROM drivers d
  WHERE d.deleted_at IS NULL AND COALESCE(d.driver_status::text,'') <> 'deleted'
    AND (d.service_area_id = p_service_area_id
         OR EXISTS (SELECT 1 FROM driver_service_areas j WHERE j.driver_id = d.id AND j.service_area_id = p_service_area_id));
  IF v_live_drivers > 0 THEN
    RAISE EXCEPTION 'SERVICE_AREA_HAS_DRIVERS: % driver(s) still assigned', v_live_drivers;
  END IF;

  SELECT count(*) INTO v_open_trips FROM trips t
  WHERE t.service_area_id = p_service_area_id
    AND upper(COALESCE(t.status::text,'')) NOT IN ('COMPLETED','CANCELLED','NO_SHOW','LATE_PASSENGER_CANCELLATION','EXPIRED','FAILED');
  IF v_open_trips > 0 THEN
    RAISE EXCEPTION 'SERVICE_AREA_HAS_OPEN_TRIPS: % open trip(s)', v_open_trips;
  END IF;

  -- Deleted drivers' leftover assignments are released first.
  DELETE FROM driver_service_areas WHERE service_area_id = p_service_area_id;

  BEGIN
    DELETE FROM service_areas WHERE id = p_service_area_id;
    RETURN jsonb_build_object('outcome', 'deleted');
  EXCEPTION WHEN foreign_key_violation OR restrict_violation OR raise_exception THEN
    UPDATE service_areas
       SET is_active = false, archived_at = now(), archived_by = auth.uid(), updated_at = now()
     WHERE id = p_service_area_id;
    RETURN jsonb_build_object('outcome', 'archived', 'reason', 'Service area has financial or trip history that must be kept');
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_remove_service_area(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remove_service_area(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_restore_service_area(p_service_area_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE service_areas SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = p_service_area_id;
END; $$;
REVOKE ALL ON FUNCTION public.admin_restore_service_area(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_restore_service_area(uuid) TO authenticated;