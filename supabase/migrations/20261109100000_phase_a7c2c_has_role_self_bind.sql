-- Phase A7C2C: bind has_role to the session actor.
-- NOT APPLIED until explicitly approved.
--
-- Authenticated callers may evaluate only their own auth.uid().
-- A different user id or a null auth.uid() returns false.
-- No owner-session exception and no service-role arbitrary-user exception.
-- RLS, Storage, Realtime, views, and nested parents that pass auth.uid()
-- remain compatible because auth.uid() equals the supplied _user_id.
-- Signature, volatility, owner, search_path, and ACL are unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND _user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_roles.user_id = _user_id
        AND user_roles.role = _role
    )
$function$;

COMMIT;
