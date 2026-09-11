-- ============================================================
-- Phase A8B26: lost_property_admin_unread_count body authorization lock
-- Applied to ACTIVE_HEALTHY as 20261109400000.
--
-- Target: public.lost_property_admin_unread_count()
-- Baseline body_md5:  db6f1af9a933be79c723379c98d2eb35
-- Applied body_md5:   9fd0d843f5bc03ab2051565fd5f94922
--
-- Vulnerability: SECURITY DEFINER global Admin unread-case count with
--   no auth.uid() / staff gate. Any authenticated JWT can observe Admin
--   lost-property operational activity volume.
--
-- Proven callers:
--   Admin web useLostPropertyUnreadCount → supabase.rpc (user JWT)
--     badge in AdminSidebar (page slug lost-property)
--   Edge lost-property?action=admin_unread_count → getServiceClient().rpc
--     AFTER requireAdmin(req); config verify_jwt=false; version 266
--   No Driver / Customer / Corporate / Guest / SQL parent / trigger /
--   RLS / view / cron runtime caller. Types-only elsewhere.
--
-- Established Admin page model (no fabricated action key):
--   role_page_permissions.page_slug = 'lost-property'
--   staff_has_page_access('lost-property') requires active staff_profiles
--
-- Remediation (NEEDS_BODY_AUTHORIZATION / Option A):
--   Gate: auth.role() = 'service_role' OR staff_has_page_access('lost-property')
--   Preserve exact count SELECT semantics, owner, STABLE SECDEF, search_path.
--   Retain authenticated EXECUTE (Admin browser RPC).
--   Retain service_role EXECUTE (Edge service client; no Edge deploy).
--   Never grant PUBLIC/anon. Do not use profiles.role / current_user /
--   user metadata / caller-supplied actor.
--
-- Note: Edge requireAdmin still checks profiles.role='admin' (incomplete
--   vs staff model). Preserved as deployed; RPC body is the direct-exposure fix.
--
-- Expected authenticated SECDEF count: unchanged 110
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1)
     IS DISTINCT FROM '20261109390000' THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: unexpected latest migration';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109400000') THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: migration already recorded';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'lost_property_admin_unread_count'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_md5 IS DISTINCT FROM 'db6f1af9a933be79c723379c98d2eb35' THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: baseline md5=%', v_md5;
  END IF;

  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'lost_property_admin_unread_count') <> 1 THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: unexpected overload count';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: baseline ACL drift';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: auth_secdef=%', v_auth;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.lost_property_admin_unread_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Admin sidebar badge (user JWT) + Edge lost-property admin_unread_count
  -- (service_role after requireAdmin). Page slug proven: lost-property.
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('lost-property') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COUNT(*)::integer FROM public.lost_property_cases
    WHERE status NOT IN ('CLOSED')
      AND (
        status = 'NEW'
        OR (status = 'SENT_TO_DRIVER' AND admin_viewed_at IS NULL)
        OR (status = 'ESCALATED' AND admin_viewed_at IS NULL)
        OR (admin_last_read_message_at IS NULL AND EXISTS (
          SELECT 1 FROM public.lost_property_messages m
          WHERE m.case_id = lost_property_cases.id
            AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
        ))
        OR (admin_last_read_message_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.lost_property_messages m
          WHERE m.case_id = lost_property_cases.id
            AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
            AND m.created_at > lost_property_cases.admin_last_read_message_at
        ))
      )
  );
END;
$function$;

COMMENT ON FUNCTION public.lost_property_admin_unread_count() IS
  'Global Admin lost-property unread case count. Restricted to service_role or staff_has_page_access(lost-property).';

REVOKE ALL ON FUNCTION public.lost_property_admin_unread_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_admin_unread_count() FROM anon;
GRANT EXECUTE ON FUNCTION public.lost_property_admin_unread_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_admin_unread_count() TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'lost_property_admin_unread_count'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_md5 IS DISTINCT FROM '9fd0d843f5bc03ab2051565fd5f94922' THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: proposed md5=%', v_md5;
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: proposed ACL drift';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B26 HARD STOP: auth_secdef changed to %', v_auth;
  END IF;
END $$;

COMMIT;
