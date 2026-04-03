CREATE OR REPLACE FUNCTION public.enforce_document_delete_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean;
  v_is_system_delete boolean;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  v_is_system_delete := auth.uid() IS NULL OR auth.role() = 'service_role';

  IF v_is_admin OR v_is_system_delete THEN
    RETURN OLD;
  END IF;

  IF OLD.status = 'approved' THEN
    IF OLD.expiry_date IS NULL OR OLD.expiry_date >= now() THEN
      RAISE EXCEPTION 'Cannot delete an approved document. Contact admin to unlock it.';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;