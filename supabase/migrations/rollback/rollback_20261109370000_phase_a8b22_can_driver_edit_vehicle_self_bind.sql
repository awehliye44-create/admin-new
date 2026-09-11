-- Rollback Phase A8B22. Restores exact pre-change production body and safe ACL.
-- Production body_md5 before A8B22: 49ee9d3d28b6b13d4e341f108eba79e5
-- Never GRANT PUBLIC or anon.

BEGIN;

CREATE OR REPLACE FUNCTION public.can_driver_edit_vehicle(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vehicle_locked boolean;
  v_approval_status text;
BEGIN
  SELECT vehicle_locked, approval_status
  INTO v_vehicle_locked, v_approval_status
  FROM drivers
  WHERE id = p_driver_id;
  
  -- Can edit if not locked OR if driver is still pending approval
  RETURN (NOT COALESCE(v_vehicle_locked, false)) OR (v_approval_status = 'pending');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.can_driver_edit_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_driver_edit_vehicle(uuid) TO service_role;

COMMIT;
