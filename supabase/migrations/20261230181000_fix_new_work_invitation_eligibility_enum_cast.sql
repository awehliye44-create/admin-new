-- Fix MK-261105-002 helper: driver_status / approval_status are enums —
-- COALESCE(..., '') coerced '' into the enum and raised 22P02.

CREATE OR REPLACE FUNCTION public.driver_eligible_for_new_work_invitation(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_approval text;
  v_status text;
  v_deleted timestamptz;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT
    lower(COALESCE(d.approval_status::text, '')),
    lower(COALESCE(d.driver_status::text, '')),
    d.deleted_at
  INTO v_approval, v_status, v_deleted
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_deleted IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_approval IN ('suspended', 'rejected', 'declined', 'disabled') THEN
    RETURN false;
  END IF;
  IF v_approval IS DISTINCT FROM 'approved' THEN
    RETURN false;
  END IF;

  IF v_status IN (
    'deleted', 'soft_deleted', 'suspended', 'disabled', 'inactive', 'blocked'
  ) THEN
    RETURN false;
  END IF;
  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;

  RETURN public.check_driver_documents_approved(p_driver_id);
END;
$function$;

COMMENT ON FUNCTION public.driver_eligible_for_new_work_invitation(uuid) IS
  'MK-261105-002: approved+active+not deleted/suspended + live check_driver_documents_approved. Enum-safe casts.';
