-- Rollback Phase A7C1. Restores the captured production bodies.
-- ACL is not changed.

BEGIN;

CREATE OR REPLACE FUNCTION public.has_corporate_access(p_user_id uuid, p_corporate_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.corporate_user_accounts
    WHERE user_id = p_user_id
    AND corporate_account_id = p_corporate_account_id
  )
$function$;

CREATE OR REPLACE FUNCTION public.can_write_corporate(p_user_id uuid, p_corporate_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.corporate_user_accounts cua
    WHERE cua.user_id = p_user_id
    AND cua.corporate_account_id = p_corporate_account_id
    AND cua.role IN ('admin', 'manager')
  )
$function$;

COMMIT;
