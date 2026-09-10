-- ============================================================
-- Phase A8B13B2: close direct UPDATE bypass on corporate_account_requests
-- Applied: canonical version 20261109270000.
--
-- Preconditions (verified before apply):
--   1) A8B13B reject RPC live (20261109260000)
--   2) Admin AccountRequests.tsx uses approve/reject/suspend RPCs
--   3) Corporate Portal A8B13B1 retired embedded /admin request UPDATE
--
-- Replaces ALL policy "Admins can manage account requests" with SELECT-only
-- for has_role(admin). Applicant INSERT + own SELECT unchanged.
-- No applicant UPDATE/DELETE policy. No replacement ALL policy.
-- Review mutations: approve / suspend / reject RPCs only.
-- ============================================================

DROP POLICY IF EXISTS "Admins can manage account requests"
  ON public.corporate_account_requests;

CREATE POLICY "Admins can select account requests"
  ON public.corporate_account_requests
  FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role));
