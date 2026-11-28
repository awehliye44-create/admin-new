-- When a driver re-uploads after Admin rejection, vehicle-scoped demote updates
-- is_current on the rejected row. guard_driver_document_writes was forcing
-- status back to pending and clearing rejection_reason — wiping history.
-- Preserve rejected/expired (and approved) on versioning-only demotes.
-- Local/non-prod only until hosted verification. Contracts remain verified:false.

BEGIN;

CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean;
BEGIN
  IF current_setting('onecab.admin_page_mutate', true) = '1' THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL AND auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Versioning demote/link must keep prior review outcome (approved/rejected/expired).
  IF TG_OP = 'UPDATE'
     AND lower(COALESCE(OLD.status, '')) IN ('approved', 'rejected', 'expired')
     AND public.document_update_is_versioning_only(OLD, NEW) THEN
    RETURN NEW;
  END IF;

  NEW.status := 'pending';
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  NEW.rejection_reason := NULL;

  RETURN NEW;
END;
$$;

COMMIT;
