-- Driver document renewal: "Upload failed — DRIVER_PRIVILEGED_FIELD_FORBIDDEN".
--
-- submit_driver_document inserts the renewal as the current pending row.
-- update_driver_docs_status (AFTER on documents) then re-derives
-- drivers.documents_approved / onboarding_complete from
-- check_driver_documents_approved. SECURITY DEFINER does not change auth.uid(),
-- so the guard saw the Driver's own session flip those columns and raised,
-- rolling back the whole submission. recalculate_driver_documents_approved
-- (Driver Home repair RPC) hit the same wall.
--
-- The guard still forbids a Driver session from writing any value of its own
-- choosing. documents_approved / onboarding_complete may change only to the
-- server-derived compliance value. approval_status, driver_status and Terms
-- are unchanged. Presence stays owned by tr_guard_driver_availability_columns.

CREATE OR REPLACE FUNCTION public.enforce_driver_privileged_column_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allow_terms text := coalesce(current_setting('onecab.allow_driver_terms_write', true), '');
  v_derived_documents_approved boolean;
BEGIN
  IF public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.user_id THEN
    IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.driver_status IS DISTINCT FROM OLD.driver_status THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    -- Document flags are derived, never client-chosen: allow only the value
    -- check_driver_documents_approved computes inside this transaction.
    IF NEW.documents_approved IS DISTINCT FROM OLD.documents_approved
       OR NEW.onboarding_complete IS DISTINCT FROM OLD.onboarding_complete
    THEN
      v_derived_documents_approved := public.check_driver_documents_approved(OLD.id);
      IF NEW.documents_approved IS DISTINCT FROM OLD.documents_approved
         AND NEW.documents_approved IS DISTINCT FROM v_derived_documents_approved
      THEN
        RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
      IF NEW.onboarding_complete IS DISTINCT FROM OLD.onboarding_complete
         AND NEW.onboarding_complete IS DISTINCT FROM v_derived_documents_approved
      THEN
        RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Presence (is_online / driver_online_intent / online_since): owned by
    -- tr_guard_driver_availability_columns + allow_driver_availability_write().
    -- Do not re-block here — that breaks driver_request_go_online.

    -- Terms: client may never set or change; finalize sets local GUC first.
    IF v_allow_terms IS DISTINCT FROM '1'
       AND (
         NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at
         OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
       )
    THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
