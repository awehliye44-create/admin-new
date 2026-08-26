-- ============================================================
-- ROLLBACK for 20261026150000_document_renewal_versioning_lock.sql
--
-- Restores the pre-fix enforce_document_lock / guard_driver_document_writes
-- (approved non-expired UPDATE always rejected; guard always forces pending).
-- Does NOT remove the forward migration from schema_migrations.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_document_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
  today_london date;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  today_london := public.driver_compliance_today_london();

  IF OLD.status = 'approved' THEN
    IF OLD.expiry_date IS NOT NULL AND OLD.expiry_date < today_london THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot modify an approved document. Contact admin to unlock it.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  -- Service-role / system migrations: auth.uid() null with service_role
  IF auth.uid() IS NULL AND auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  NEW.status := 'pending';
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  -- Keep rejection_reason only when an admin previously set it on OLD;
  -- driver resubmits always clear it.
  IF TG_OP = 'INSERT' THEN
    NEW.rejection_reason := NULL;
  ELSE
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

DROP FUNCTION IF EXISTS public.document_update_is_versioning_only(public.documents, public.documents);

COMMIT;
