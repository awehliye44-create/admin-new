-- Let the authenticated Driver refresh their own documents_approved /
-- onboarding_complete from live eligibility when Admin approval left
-- the cached booleans stale (calendar refresh / missed trigger).

CREATE OR REPLACE FUNCTION public.sync_current_driver_document_approval()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_approved boolean;
BEGIN
  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  v_approved := public.check_driver_documents_approved(v_driver_id);

  UPDATE public.drivers d
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE d.id = v_driver_id
    AND (
      d.documents_approved IS DISTINCT FROM v_approved
      OR d.onboarding_complete IS DISTINCT FROM v_approved
    );

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', v_driver_id,
    'approved', v_approved
  );
END;
$function$;

COMMENT ON FUNCTION public.sync_current_driver_document_approval() IS
  'Authenticated Driver: recompute documents_approved + onboarding_complete from live eligibility SSOT.';

REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO service_role;
