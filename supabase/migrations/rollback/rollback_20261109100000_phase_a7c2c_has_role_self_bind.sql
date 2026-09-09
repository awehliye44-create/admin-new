-- Rollback Phase A7C2C. Restores the captured production body.
-- ACL is not changed.

BEGIN;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = _user_id
      AND user_roles.role = _role
  )
$function$;

COMMIT;
