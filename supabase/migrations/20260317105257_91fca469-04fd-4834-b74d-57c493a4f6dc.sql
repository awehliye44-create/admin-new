
-- When document_types toggles change (is_active or is_required),
-- recalculate documents_approved for ALL drivers automatically.
CREATE OR REPLACE FUNCTION public.recalculate_all_drivers_doc_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Only act when is_active or is_required changed
  IF (TG_OP = 'UPDATE' AND (
       OLD.is_active IS DISTINCT FROM NEW.is_active OR
       OLD.is_required IS DISTINCT FROM NEW.is_required
     ))
     OR TG_OP = 'DELETE'
     OR TG_OP = 'INSERT'
  THEN
    UPDATE public.drivers
    SET 
      documents_approved = public.check_driver_documents_approved(id),
      updated_at = now();

    -- Force offline any drivers who lost compliance
    UPDATE public.drivers
    SET 
      is_online = false,
      updated_at = now()
    WHERE approval_status = 'approved'
      AND documents_approved = false;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS tr_recalc_drivers_on_doctype_change ON public.document_types;

CREATE TRIGGER tr_recalc_drivers_on_doctype_change
  AFTER INSERT OR UPDATE OR DELETE ON public.document_types
  FOR EACH ROW
  EXECUTE FUNCTION public.recalculate_all_drivers_doc_status();

-- Re-evaluate all drivers RIGHT NOW to fix any stale state
UPDATE public.drivers
SET 
  documents_approved = public.check_driver_documents_approved(id),
  updated_at = now();
