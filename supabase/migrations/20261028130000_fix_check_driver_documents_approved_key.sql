-- check_driver_documents_approved drifted to read JSON key `eligible`, but
-- get_driver_document_eligibility SSOT exposes `approved` only. That left
-- documents_approved / onboarding_complete false for compliant drivers and
-- enforce_online_eligibility blocked go-online despite live eligibility clear.

CREATE OR REPLACE FUNCTION public.check_driver_documents_approved(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (payload ->> 'approved')::boolean,
    (payload ->> 'eligible')::boolean,
    false
  )
  FROM (SELECT public.get_driver_document_eligibility(p_driver_id) AS payload) AS eligibility;
$function$;

COMMENT ON FUNCTION public.check_driver_documents_approved(uuid) IS
  'True when get_driver_document_eligibility.approved (or legacy eligible) is true for assigned-SA mandatory docs.';

-- Repair cached booleans that drifted while check_* read the wrong JSON key.
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
