-- ============================================================
-- Phase A8B13B: reject_corporate_request RPC (authorized)
-- Applied: canonical version 20261109260000.
--
-- Companion: Admin UI AccountRequests.tsx must switch rejectMutation
-- from direct table UPDATE to this RPC before RLS closure (A8B13B2).
--
-- Proven page contract (matches approve/suspend):
--   route /account-requests
--   sidebar PermissionNavItem pageSlug=account-requests
--   AdminPageAccessGate slug from path
--   staff_has_page_access('account-requests')
--
-- No live reject_corporate_request exists today.
-- Direct UPDATE via "Admins can manage account requests" (has_role admin)
-- allows spoofing reviewed_by and writing arbitrary columns.
--
-- Gate: service_role OR staff_has_page_access('account-requests')
-- Staff JWT stamps auth.uid() as reviewer (ignore client reviewer).
-- Transitions: pending | under_review only (matches Admin UI buttons).
-- Does not create/delete corporate_accounts.
-- Authenticated EXECUTE kept for Admin JWT caller.
-- Proposed body_md5: baaa27a6183d5b25e45ea83f3f0eaee7
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reject_corporate_request(
  p_request_id uuid,
  p_rejection_reason text DEFAULT NULL::text,
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
  v_reason text;
  v_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_reviewer := CASE
    WHEN auth.role() = 'service_role' THEN COALESCE(p_reviewed_by, auth.uid())
    ELSE auth.uid()
  END;

  v_reason := NULLIF(btrim(COALESCE(p_rejection_reason, '')), '');
  IF v_reason IS NOT NULL AND char_length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'rejection reason too long';
  END IF;

  SELECT status INTO v_status
  FROM public.corporate_account_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_status IS DISTINCT FROM 'pending'
     AND v_status IS DISTINCT FROM 'under_review' THEN
    RAISE EXCEPTION 'Request cannot be rejected from status %', v_status;
  END IF;

  UPDATE public.corporate_account_requests
  SET status = 'rejected',
      rejection_reason = v_reason,
      reviewed_at = now(),
      reviewed_by = v_reviewer,
      updated_at = now()
  WHERE id = p_request_id;
END;
$fn$;

COMMENT ON FUNCTION public.reject_corporate_request(uuid, text, uuid) IS
  'Phase A8B13B: service_role OR staff_has_page_access(account-requests). Staff JWT stamps auth.uid(). Rejects pending/under_review only.';

REVOKE ALL ON FUNCTION public.reject_corporate_request(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_corporate_request(uuid, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_corporate_request(uuid, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_corporate_request(uuid, text, uuid) TO service_role;

COMMIT;
