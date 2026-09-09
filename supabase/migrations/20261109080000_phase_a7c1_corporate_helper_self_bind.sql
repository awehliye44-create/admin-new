-- Phase A7C1: self-bind corporate RLS authorization helpers.
-- NOT APPLIED until explicitly approved.
--
-- Authenticated callers may evaluate only their own auth.uid().
-- A different user id, a missing JWT, or a null auth.uid() returns false.
-- service_role JWT presents auth.role() = service_role and a null auth.uid().
-- No production caller needs an arbitrary-user lookup, so there is no
-- service-role exception. The function owner session is not treated as a
-- trusted caller, because these definer helpers run as the owner for every invoker.
-- Signatures, volatility, owner, search_path, and ACL are unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.has_corporate_access(p_user_id uuid, p_corporate_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND p_user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.corporate_user_accounts
      WHERE user_id = p_user_id
        AND corporate_account_id = p_corporate_account_id
    );
$function$;

CREATE OR REPLACE FUNCTION public.can_write_corporate(p_user_id uuid, p_corporate_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND p_user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.corporate_user_accounts cua
      WHERE cua.user_id = p_user_id
        AND cua.corporate_account_id = p_corporate_account_id
        AND cua.role IN ('admin', 'manager')
    );
$function$;

COMMIT;
