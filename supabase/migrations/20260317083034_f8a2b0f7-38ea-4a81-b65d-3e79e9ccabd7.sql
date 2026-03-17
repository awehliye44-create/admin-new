
-- 1. Re-evaluate documents_approved for ALL drivers using the existing function
UPDATE public.drivers
SET 
  documents_approved = public.check_driver_documents_approved(id),
  updated_at = now();

-- 2. Revoke approval_status for drivers whose documents are not approved
UPDATE public.drivers
SET 
  approval_status = 'pending',
  is_online = false,
  updated_at = now()
WHERE approval_status = 'approved'
  AND documents_approved = false;

-- 3. Add a DB-level trigger to prevent approving drivers without valid documents
CREATE OR REPLACE FUNCTION public.guard_driver_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- When setting approval_status to 'approved', verify documents are all valid
  IF NEW.approval_status = 'approved' 
     AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved') THEN
    
    -- Re-check documents right now
    NEW.documents_approved := public.check_driver_documents_approved(NEW.id);
    
    IF NEW.documents_approved != true THEN
      RAISE EXCEPTION 'Cannot approve driver: required documents are missing, pending, rejected, or expired';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Drop if exists to avoid duplicate
DROP TRIGGER IF EXISTS tr_guard_driver_approval ON public.drivers;

CREATE TRIGGER tr_guard_driver_approval
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_driver_approval();
