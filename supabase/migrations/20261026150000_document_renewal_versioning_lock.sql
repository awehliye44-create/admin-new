-- Eligible renewal inserts a pending current row; trg_documents_demote_current_before
-- then UPDATEs the previous approved row (is_current / superseded_by / updated_at).
-- enforce_document_lock previously treated that versioning UPDATE as a forbidden
-- content edit and rolled back the whole submit.
--
-- Allow versioning-only updates on approved rows. Do NOT unlock content edits
-- via can_upload_replacement. Admin bypass unchanged.
--
-- Companion: guard_driver_document_writes must not rewrite status/reviewer
-- fields on those same versioning-only UPDATEs, or the historical approved
-- row would be coerced to pending.

CREATE OR REPLACE FUNCTION public.document_update_is_versioning_only(
  p_old public.documents,
  p_new public.documents
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $function$
  SELECT
    p_old.id IS NOT DISTINCT FROM p_new.id
    AND p_old.driver_id IS NOT DISTINCT FROM p_new.driver_id
    AND p_old.document_type IS NOT DISTINCT FROM p_new.document_type
    AND p_old.document_name IS NOT DISTINCT FROM p_new.document_name
    AND p_old.file_url IS NOT DISTINCT FROM p_new.file_url
    AND p_old.status IS NOT DISTINCT FROM p_new.status
    AND p_old.expiry_date IS NOT DISTINCT FROM p_new.expiry_date
    AND p_old.notes IS NOT DISTINCT FROM p_new.notes
    AND p_old.rejection_reason IS NOT DISTINCT FROM p_new.rejection_reason
    AND p_old.reviewed_by IS NOT DISTINCT FROM p_new.reviewed_by
    AND p_old.reviewed_at IS NOT DISTINCT FROM p_new.reviewed_at
    AND p_old.created_at IS NOT DISTINCT FROM p_new.created_at
    AND p_old.document_type_id IS NOT DISTINCT FROM p_new.document_type_id
    AND p_old.last_reminded_at IS NOT DISTINCT FROM p_new.last_reminded_at
    AND p_old.reminder_sent_days IS NOT DISTINCT FROM p_new.reminder_sent_days
    AND p_old.submission_idempotency_key IS NOT DISTINCT FROM p_new.submission_idempotency_key;
$function$;

COMMENT ON FUNCTION public.document_update_is_versioning_only(public.documents, public.documents) IS
  'True when NEW differs from OLD only in is_current, superseded_by, and/or updated_at.';

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
    IF public.document_update_is_versioning_only(OLD, NEW) THEN
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

  -- Versioning demote/link of an approved row must keep status='approved'.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'approved'
     AND public.document_update_is_versioning_only(OLD, NEW) THEN
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

INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20261026150000')
ON CONFLICT DO NOTHING;
