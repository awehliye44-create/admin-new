-- Rollback Phase A8B28. Restores the captured production body for
-- public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid).
-- ACL is not changed.
--
-- Restored md5(prosrc) must equal baseline:
--   b000bb084232102300009c2a03d9bcb0

BEGIN;

CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM trips t
    JOIN corporate_user_accounts cua ON cua.corporate_account_id = t.corporate_account_id
    WHERE t.driver_id = p_driver_id
      AND cua.user_id = p_user_id
      AND COALESCE(t.status, '') NOT IN ('cancelled', 'completed')
  )
$function$;

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_corporate_user_view_driver'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid, p_user_id uuid';

  IF v_md5 IS DISTINCT FROM 'b000bb084232102300009c2a03d9bcb0' THEN
    RAISE EXCEPTION 'A8B28 ROLLBACK HARD STOP: unexpected restored md5(prosrc)=%', v_md5;
  END IF;
END $$;

COMMIT;
