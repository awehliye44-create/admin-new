-- ============================================================
-- Phase A8B22: can_driver_edit_vehicle self-bind lock
-- Applied to ACTIVE_HEALTHY.
--
-- Target: public.can_driver_edit_vehicle(p_driver_id uuid) RETURNS boolean
-- Baseline body_md5:  49ee9d3d28b6b13d4e341f108eba79e5
-- Proposed body_md5:  25e0661516a3f94821b02a0fabe69cab
--
-- Vulnerability: SECURITY DEFINER read of drivers.vehicle_locked /
--   approval_status for ANY p_driver_id with no auth.uid() bind.
--   Any authenticated client can probe another driver's lock/pending state.
--
-- Proven callers:
--   Driver native authenticatedDriverProfile.fetchCanEditVehicle(own driverId)
--   SQL trigger parent public.check_vehicle_edit_allowed on public.vehicles
--     (auth EXECUTE revoked; runs as trigger; skips via has_role admin;
--      otherwise calls can_driver_edit_vehicle(NEW.driver_id))
--   No Customer / Corporate / Guest / Edge .rpc callers
--   Admin uses get_driver_standards (already self|admin bound), not this RPC
--
-- Remediation (NEEDS_SELF_BIND):
--   When auth.uid() IS NOT NULL, require
--     drivers.id = p_driver_id AND drivers.user_id = auth.uid()
--     AND deleted_at IS NULL
--     else SQLSTATE 42501 'not authorized'
--   When auth.uid() IS NULL, retain legacy lock evaluation for the
--     resolved vehicles trigger / service_role internal path only.
--     This is not an authenticated cross-driver grant.
--   Preserve signature, VOLATILE, SECURITY DEFINER, search_path=public,
--     owner postgres, plpgsql, and baseline ACL.
--   No current_user, profiles.role, metadata, or explicit service_role branch.
--   Do not modify check_vehicle_edit_allowed or vehicles RLS.
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: unchanged 110
-- ============================================================

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
  -- Authenticated callers may only evaluate their own driver row.
  -- Null auth.uid() preserves the vehicles trigger / service_role internal path
  -- (check_vehicle_edit_allowed); that path does not grant authenticated cross-driver reads.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.drivers d
      WHERE d.id = p_driver_id
        AND d.user_id = auth.uid()
        AND d.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

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
