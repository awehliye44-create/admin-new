-- Rollback: Phase A8B26 lost_property_admin_unread_count authz lock
-- Restores the safe baseline body + ACL only. Do not apply unless approved.

BEGIN;

CREATE OR REPLACE FUNCTION public.lost_property_admin_unread_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COUNT(*)::integer FROM public.lost_property_cases
  WHERE status NOT IN ('CLOSED')
    AND (
      status = 'NEW'
      OR (status = 'SENT_TO_DRIVER' AND admin_viewed_at IS NULL)
      OR (status = 'ESCALATED' AND admin_viewed_at IS NULL)
      OR (admin_last_read_message_at IS NULL AND EXISTS (
        SELECT 1 FROM public.lost_property_messages m
        WHERE m.case_id = lost_property_cases.id AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
      ))
      OR (admin_last_read_message_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.lost_property_messages m
        WHERE m.case_id = lost_property_cases.id AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
        AND m.created_at > lost_property_cases.admin_last_read_message_at
      ))
    );
$function$;

COMMENT ON FUNCTION public.lost_property_admin_unread_count() IS NULL;

REVOKE ALL ON FUNCTION public.lost_property_admin_unread_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_admin_unread_count() FROM anon;
GRANT EXECUTE ON FUNCTION public.lost_property_admin_unread_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_admin_unread_count() TO service_role;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='lost_property_admin_unread_count'
        AND pg_get_function_identity_arguments(p.oid)='')
     IS DISTINCT FROM 'db6f1af9a933be79c723379c98d2eb35' THEN
    RAISE EXCEPTION 'A8B26 ROLLBACK HARD STOP: baseline md5 not restored';
  END IF;
END $$;

COMMIT;
