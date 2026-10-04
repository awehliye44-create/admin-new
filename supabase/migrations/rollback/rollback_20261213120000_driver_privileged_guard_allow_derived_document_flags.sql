-- Restores the pre-20261213120000 production guard (md5 0a1ef536c1874e451c9a22a568a28b22).
-- Re-breaks Driver document renewal and the Home documents_approved repair RPC.

CREATE OR REPLACE FUNCTION public.enforce_driver_privileged_column_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allow_terms text := coalesce(current_setting('onecab.allow_driver_terms_write', true), '');
BEGIN
  IF public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.user_id THEN
    IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.onboarding_complete IS DISTINCT FROM OLD.onboarding_complete THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.documents_approved IS DISTINCT FROM OLD.documents_approved THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.driver_status IS DISTINCT FROM OLD.driver_status THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
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
