-- Admin "Add driver documents" loads compliance via get_driver_document_compliance.
-- Production app_role is only (admin, moderator, user, driver, customer). The RPC still
-- called has_role(..., 'staff') / has_role(..., 'super_admin'), which raise
-- invalid input value for enum app_role whenever the caller is not already
-- has_role(admin) (boolean OR still evaluates the next operand in PL/pgSQL).
-- Staff Console auth is staff_profiles + is_super_admin — match that.

CREATE OR REPLACE FUNCTION public.get_driver_document_compliance(_driver_id uuid DEFAULT NULL)
RETURNS SETOF public.driver_document_compliance_ssot
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid;
  v_is_privileged boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  v_is_privileged :=
    public.has_role(v_uid, 'admin'::public.app_role)
    OR public.is_super_admin(v_uid)
    OR EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = v_uid
        AND sp.is_active = true
    );

  IF _driver_id IS NOT NULL THEN
    IF NOT v_is_privileged THEN
      SELECT id INTO v_target FROM public.drivers WHERE user_id = v_uid LIMIT 1;
      IF v_target IS NULL OR v_target <> _driver_id THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
      END IF;
    END IF;
    v_target := _driver_id;
  ELSE
    SELECT id INTO v_target FROM public.drivers WHERE user_id = v_uid LIMIT 1;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'no_driver_profile' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.driver_document_compliance_ssot
  WHERE driver_id = v_target
  ORDER BY
    CASE expiry_status
      WHEN 'expired'        THEN 1
      WHEN 'rejected'       THEN 2
      WHEN 'missing'        THEN 3
      WHEN 'expiring_soon'  THEN 4
      WHEN 'pending'        THEN 5
      WHEN 'approved_valid' THEN 6
      ELSE 7
    END,
    display_name;
END;
$function$;

COMMENT ON FUNCTION public.get_driver_document_compliance(uuid) IS
  'Returns driver_document_compliance_ssot for the caller (driver self) or an active staff/admin target driver. Privilege uses app_role admin, is_super_admin, or active staff_profiles — never invalid app_role labels.';

REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO service_role;
