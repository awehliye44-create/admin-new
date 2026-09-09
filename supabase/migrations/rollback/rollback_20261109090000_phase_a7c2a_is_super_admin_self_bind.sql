-- Rollback Phase A7C2A. Restores the captured production body.
-- ACL is not changed.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    CASE
      WHEN public.is_owner(_user_id) THEN true
      WHEN EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = _user_id)
        THEN EXISTS (
          SELECT 1 FROM public.staff_profiles sp
          WHERE sp.user_id = _user_id AND sp.is_active = true AND sp.role = 'super_admin'
        )
      ELSE public.has_role(_user_id, 'admin'::public.app_role)
    END
$function$;

COMMIT;
