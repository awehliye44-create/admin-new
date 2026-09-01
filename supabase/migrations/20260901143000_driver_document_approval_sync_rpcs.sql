-- Ensure authenticated Drivers can refresh their own documents_approved /
-- onboarding_complete from live eligibility (Admin approval / calendar refresh).

CREATE OR REPLACE FUNCTION public.recalculate_driver_documents_approved(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_approved boolean;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN false;
  END IF;

  -- Drivers may only refresh their own row.
  IF p_driver_id IS DISTINCT FROM public.current_driver_id() THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_approved := public.check_driver_documents_approved(p_driver_id);

  UPDATE public.drivers d
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE d.id = p_driver_id
    AND (
      d.documents_approved IS DISTINCT FROM v_approved
      OR d.onboarding_complete IS DISTINCT FROM v_approved
    );

  RETURN v_approved;
END;
$function$;

COMMENT ON FUNCTION public.recalculate_driver_documents_approved(uuid) IS
  'Authenticated Driver: recompute documents_approved + onboarding_complete for current_driver_id().';

REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_documents_approved(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_documents_approved(uuid) TO service_role;

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

  v_approved := public.recalculate_driver_documents_approved(v_driver_id);

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

-- Backfill any drivers whose cached booleans drifted from live eligibility.
UPDATE public.drivers d
SET
  documents_approved = src.approved,
  onboarding_complete = src.approved,
  updated_at = now()
FROM (
  SELECT id, public.check_driver_documents_approved(id) AS approved
  FROM public.drivers
  WHERE deleted_at IS NULL
) src
WHERE d.id = src.id
  AND (
    d.documents_approved IS DISTINCT FROM src.approved
    OR d.onboarding_complete IS DISTINCT FROM src.approved
  );
