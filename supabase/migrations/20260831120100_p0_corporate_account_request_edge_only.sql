-- P0: Corporate account requests — anonymous submissions via Edge Function only.
-- Authenticated self-service INSERT policy preserved for logged-in corporate_web applicants.
-- Rollback (manual only, NOT a migration): supabase/rollback/p0_security_hardening_rollback_20260831.sql

DROP POLICY IF EXISTS "Anonymous can submit account requests" ON public.corporate_account_requests;

-- Belt-and-suspenders: anon cannot INSERT even if a policy is re-added accidentally.
REVOKE INSERT ON TABLE public.corporate_account_requests FROM anon;
