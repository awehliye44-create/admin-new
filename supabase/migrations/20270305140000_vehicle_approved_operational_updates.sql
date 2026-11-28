-- Allow SECURITY DEFINER lifecycle RPCs (driver JWT) to change operational fields
-- on an already-approved vehicle (suspend / restore / trip-active) without
-- rewriting identity. Identity mutations on approved vehicles remain admin-only.
-- Do not apply to production thazislrdkjpvvghtvzo until authenticated non-prod/local
-- E2E passes. Contracts remain verified:false for hosted release.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_vehicle_not_approved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean := public.has_role(auth.uid(), 'admin'::app_role);
  v_identity_changed boolean;
BEGIN
  v_identity_changed :=
       NEW.make IS DISTINCT FROM OLD.make
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.year IS DISTINCT FROM OLD.year
    OR NEW.color IS DISTINCT FROM OLD.color
    OR NEW.license_plate IS DISTINCT FROM OLD.license_plate
    OR NEW.capacity IS DISTINCT FROM OLD.capacity
    OR NEW.vehicle_type_id IS DISTINCT FROM OLD.vehicle_type_id;

  IF OLD.approval_status = 'approved' THEN
    IF NOT v_is_admin AND v_identity_changed THEN
      RAISE EXCEPTION 'Cannot modify approved vehicle information. Please contact support.';
    END IF;
    -- Operational updates (suspend/reactivate/set-active) must keep approval.
    IF NOT v_is_admin THEN
      NEW.approval_status := OLD.approval_status;
      NEW.rejection_reason := OLD.rejection_reason;
    END IF;
    RETURN NEW;
  END IF;

  -- Non-approved rows: non-admin edits stay pending; admins may set approved.
  IF NOT v_is_admin THEN
    NEW.approval_status := 'pending';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
