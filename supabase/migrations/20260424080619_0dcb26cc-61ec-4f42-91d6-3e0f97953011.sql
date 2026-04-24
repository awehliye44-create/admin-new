-- Allow admin "soft approval" of driver profile (identity + vehicle) without
-- requiring all documents to be approved. Document approval remains a separate
-- workflow on the Driver Documents page, and online eligibility is already
-- gated independently by enforce_online_eligibility (which forces drivers
-- offline unless approval_status='approved' AND documents_approved=true).
--
-- Previously, guard_driver_approval would RAISE EXCEPTION when a driver was
-- approved without all required documents being valid, causing "Failed to
-- update driver status" toasts in the admin panel. We now simply sync the
-- documents_approved flag from the current document state and let approval
-- proceed; the driver will be unable to go online until documents are valid.

CREATE OR REPLACE FUNCTION public.guard_driver_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- When approving a driver, recompute documents_approved from the current
  -- document state, but do NOT block the approval if documents are incomplete.
  -- Online eligibility is enforced separately by enforce_online_eligibility.
  IF NEW.approval_status = 'approved'
     AND (OLD.approval_status IS NULL OR OLD.approval_status != 'approved') THEN
    NEW.documents_approved := public.check_driver_documents_approved(NEW.id);
  END IF;

  RETURN NEW;
END;
$function$;