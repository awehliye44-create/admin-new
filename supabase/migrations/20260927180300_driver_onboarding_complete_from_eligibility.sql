-- Document onboarding completion SSOT.
-- When all required (mandatory) documents for the driver's assigned service
-- area(s) are approved and valid, mark onboarding_complete. Optional docs and
-- expiring-soon must not block. Missing/pending/rejected/expired required docs
-- clear onboarding_complete so the Driver app returns to My Documents.
-- Reuses check_driver_documents_approved → get_driver_document_eligibility.
-- Does not invent a new Admin approval workflow.

CREATE OR REPLACE FUNCTION public.update_driver_document_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := COALESCE(NEW.driver_id, OLD.driver_id);
  v_approved boolean;
BEGIN
  IF v_driver_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_approved := public.check_driver_documents_approved(v_driver_id);

  UPDATE public.drivers
  SET
    documents_approved = v_approved,
    onboarding_complete = v_approved,
    updated_at = now()
  WHERE id = v_driver_id
    AND (
      documents_approved IS DISTINCT FROM v_approved
      OR onboarding_complete IS DISTINCT FROM v_approved
    );

  RETURN COALESCE(NEW, OLD);
END;
$function$;

COMMENT ON FUNCTION public.update_driver_document_status() IS
  'Keeps drivers.documents_approved and drivers.onboarding_complete in lockstep with get_driver_document_eligibility (mandatory SA rules only).';

-- Backfill live drivers so later login/restart already matches eligibility.
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
