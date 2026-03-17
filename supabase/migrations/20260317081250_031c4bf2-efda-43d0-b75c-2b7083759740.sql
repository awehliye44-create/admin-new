
-- Update check_driver_documents_approved to use document_types table dynamically
-- and check for expiry dates
CREATE OR REPLACE FUNCTION public.check_driver_documents_approved(p_driver_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  required_slugs text[];
  approved_valid_count integer;
  required_count integer;
BEGIN
  -- Dynamically get required document type slugs from document_types table
  SELECT ARRAY_AGG(slug) INTO required_slugs
  FROM public.document_types
  WHERE is_required = true
    AND is_active = true;

  -- If no required document types configured, consider approved
  IF required_slugs IS NULL OR array_length(required_slugs, 1) IS NULL THEN
    RETURN true;
  END IF;

  required_count := array_length(required_slugs, 1);

  -- Count documents that are: uploaded, approved, and NOT expired
  SELECT COUNT(DISTINCT d.document_type)
  INTO approved_valid_count
  FROM public.documents d
  WHERE d.driver_id = p_driver_id
    AND d.document_type = ANY(required_slugs)
    AND d.status = 'approved'
    AND (d.expiry_date IS NULL OR d.expiry_date >= CURRENT_DATE);

  RETURN approved_valid_count >= required_count;
END;
$function$;
