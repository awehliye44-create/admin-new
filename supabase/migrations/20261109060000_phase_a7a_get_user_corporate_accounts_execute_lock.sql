-- Phase A7A: retire get_user_corporate_accounts client execution.
-- NOT APPLIED until explicitly approved.
--
-- Unused. No RLS, SQL, or Edge caller. service_role is not retained.
-- Body, signature, and data are unchanged.
-- Other authorization helpers are out of scope.

BEGIN;

REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM service_role;

COMMIT;
