-- Phase A7C2A: bind is_super_admin to the session actor.
-- NOT APPLIED until explicitly approved.
--
-- Authenticated callers may evaluate only their own auth.uid().
-- A different user id or a null auth.uid() returns false.
-- No owner-session exception and no service-role arbitrary-user exception.
-- Nested postgres-owned SECURITY DEFINER parents that pass auth.uid() remain compatible.
-- Signature, volatility, owner, search_path, and ACL are unchanged.
-- public.has_role is out of scope.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND _user_id IS NOT DISTINCT FROM auth.uid()
    AND CASE
      WHEN public.is_owner(_user_id) THEN true
      WHEN EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = _user_id)
        THEN EXISTS (
          SELECT 1 FROM public.staff_profiles sp
          WHERE sp.user_id = _user_id AND sp.is_active = true AND sp.role = 'super_admin'
        )
      ELSE public.has_role(_user_id, 'admin'::public.app_role)
    END;
$function$;

COMMIT;
