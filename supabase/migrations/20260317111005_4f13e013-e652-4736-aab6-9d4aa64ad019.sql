
-- Update check_driver_documents_approved to respect service_area_document_rules
-- If a driver has service areas with configured rules, use those.
-- Otherwise fall back to global document_types defaults.
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
  driver_sa_ids uuid[];
  has_sa_rules boolean;
BEGIN
  -- Get the driver's service area IDs
  SELECT ARRAY_AGG(service_area_id) INTO driver_sa_ids
  FROM public.driver_service_areas
  WHERE driver_id = p_driver_id;

  -- Check if any service area rules exist for these areas
  has_sa_rules := false;
  IF driver_sa_ids IS NOT NULL AND array_length(driver_sa_ids, 1) > 0 THEN
    SELECT EXISTS(
      SELECT 1 FROM public.service_area_document_rules
      WHERE service_area_id = ANY(driver_sa_ids)
    ) INTO has_sa_rules;
  END IF;

  IF has_sa_rules THEN
    -- Use service area rules: a doc is required if ANY of the driver's SAs marks it mandatory+active
    SELECT ARRAY_AGG(DISTINCT dt.slug) INTO required_slugs
    FROM public.service_area_document_rules sar
    JOIN public.document_types dt ON dt.id = sar.doc_type_id
    WHERE sar.service_area_id = ANY(driver_sa_ids)
      AND sar.mandatory = true
      AND sar.is_active = true
      AND dt.is_active = true;
  ELSE
    -- Fallback: use global document_types defaults
    SELECT ARRAY_AGG(slug) INTO required_slugs
    FROM public.document_types
    WHERE is_required = true
      AND is_active = true;
  END IF;

  -- If no required document types, consider approved
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

-- Also trigger recalculation when service_area_document_rules change
CREATE OR REPLACE FUNCTION public.recalc_drivers_on_sa_rule_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Recalculate for all drivers in the affected service area
  UPDATE public.drivers d
  SET
    documents_approved = public.check_driver_documents_approved(d.id),
    updated_at = now()
  FROM public.driver_service_areas dsa
  WHERE dsa.driver_id = d.id
    AND dsa.service_area_id = COALESCE(NEW.service_area_id, OLD.service_area_id);

  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS tr_recalc_drivers_on_sa_rule_change ON public.service_area_document_rules;

CREATE TRIGGER tr_recalc_drivers_on_sa_rule_change
  AFTER INSERT OR UPDATE OR DELETE ON public.service_area_document_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.recalc_drivers_on_sa_rule_change();

-- Re-evaluate all drivers now
UPDATE public.drivers
SET
  documents_approved = public.check_driver_documents_approved(id),
  updated_at = now();
