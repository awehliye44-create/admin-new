-- ============================================================
-- Phase A2: reactivate_corporate_account authorization
-- NOT APPLIED until explicitly approved.
--
-- Admin CorporateAccounts.tsx calls this with the signed-in staff JWT.
-- Page slug proven: corporate-accounts
-- (route, AdminPageAccessGate, sidebar). Live role_page_permissions:
-- admin and super_admin can_access; other staff roles cannot.
-- Reuses staff_has_page_access(text): active staff_profiles + exact slug.
-- Nested call runs as postgres, which already has EXECUTE on the helper.
-- Authenticated EXECUTE stays. No ACL change. Reactivation logic unchanged.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reactivate_corporate_account(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('corporate-accounts') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE corporate_accounts
  SET status = 'active', updated_at = now()
  WHERE id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.reactivate_corporate_account(uuid) IS
  'Phase A2: service_role OR staff_has_page_access(corporate-accounts). Fail closed. Reactivation logic unchanged.';

COMMIT;
