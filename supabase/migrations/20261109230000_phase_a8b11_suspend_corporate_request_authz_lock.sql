-- ============================================================
-- Phase A8B11: suspend_corporate_request authorization + actor binding
-- NOT APPLIED until explicitly approved.
--
-- Admin AccountRequests.tsx calls this with the signed-in staff JWT.
-- Page slug proven: account-requests
-- (route /account-requests, AdminPageAccessGate, sidebar PermissionNavItem,
-- role_page_permissions.page_slug). Live matrix: super_admin and admin
-- can_access; other staff roles cannot.
-- Reuses staff_has_page_access(text): active staff_profiles + exact slug.
-- Nested call runs as postgres owner (helper EXECUTE already granted).
-- Authenticated EXECUTE stays. No ACL change.
-- Actor binding mirrors approve_corporate_request (option A):
--   staff JWT → reviewed_by := auth.uid() (ignore client p_reviewed_by)
--   service_role → COALESCE(p_reviewed_by, auth.uid())
-- Signature preserved. Suspension transition breadth preserved.
-- No audit write in current body / approve sibling — do not add one here.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.suspend_corporate_request(
  p_request_id uuid,
  p_reviewed_by uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_reviewer uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Authenticated staff cannot stamp another reviewer.
  v_reviewer := CASE
    WHEN auth.role() = 'service_role' THEN COALESCE(p_reviewed_by, auth.uid())
    ELSE auth.uid()
  END;

  UPDATE public.corporate_account_requests
  SET status = 'suspended',
      suspended_at = now(),
      reviewed_at = now(),
      reviewed_by = v_reviewer,
      updated_at = now()
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.suspend_corporate_request(uuid, uuid) IS
  'Phase A8B11: service_role OR staff_has_page_access(account-requests). Staff JWT stamps auth.uid() as reviewer. Suspension logic otherwise unchanged.';

COMMIT;
