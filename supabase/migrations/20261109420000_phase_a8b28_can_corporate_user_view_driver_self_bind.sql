-- ============================================================
-- Phase A8B28: can_corporate_user_view_driver self-bind lock
-- NOT APPLIED until explicitly approved.
--
-- Target: public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
--   RETURNS boolean
--   LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
--   owner postgres; overload_count = 1
--
-- Hash convention (do not confuse these):
--   body_md5 / proposed = md5(pg_proc.prosrc)
--     baseline:  b000bb084232102300009c2a03d9bcb0
--     proposed:  80c738f1ab36c17174bcc98a8416855c
--   md5(pg_get_functiondef(...)) for the same live proposed body:
--     8e44e4fb68513a01b747882b3acce69e
--
-- Vulnerability: SECURITY DEFINER boolean probe accepts arbitrary
--   p_user_id with no auth.uid() bind. Any authenticated client can
--   test whether a foreign corporate user currently shares an active
--   (non-cancelled/non-completed) trip with a given driver.
--
-- Proven dependency (live):
--   View public.drivers_public_safe (security_invoker) filters with
--     can_corporate_user_view_driver(id, auth.uid())
--   OR can_passenger_view_driver(id)
--   No live table RLS policies reference this function.
--   No SQL function parents, triggers, or cron jobs call it.
--   No Admin / Driver / Customer / Corporate / Guest / Edge .rpc callers
--     (generated types only). Runtime consumers use the view path with
--     auth.uid(), which remains compatible after self-bind.
--
-- Remediation (NEEDS_SELF_BIND) — same contract family as has_role (A7C2C):
--   Require auth.uid() IS NOT NULL
--     AND p_user_id IS NOT DISTINCT FROM auth.uid()
--     AND the existing corporate active-trip EXISTS predicate
--   Foreign p_user_id / null JWT → false (boolean contract; not 42501),
--     so drivers_public_safe OR-filter never errors on bind failure.
--   Preserve signature, STABLE, SECURITY DEFINER, search_path=public,
--     owner postgres, LANGUAGE sql, and baseline ACL
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
--   No current_user, profiles.role, metadata, or service_role bypass.
--   Do not modify drivers_public_safe or can_passenger_view_driver.
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: unchanged 111
--   (body-only fix; EXECUTE retained)
--   Live baseline after A8B28F pause RPC: auth SECDEF EXECUTE count = 111
--   (was 110 when A8B28 was drafted; +1 = admin_set_driver_payout_operational_pause)
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_md5 text;
  v_args text;
  v_overloads int;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid), md5(p.prosrc)
  INTO v_args, v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_corporate_user_view_driver';

  IF v_args IS DISTINCT FROM 'p_driver_id uuid, p_user_id uuid' THEN
    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected identity args=%', v_args;
  END IF;

  IF v_md5 IS DISTINCT FROM 'b000bb084232102300009c2a03d9bcb0' THEN
    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected baseline md5(prosrc)=%', v_md5;
  END IF;

  SELECT count(*)::int INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_corporate_user_view_driver';

  IF v_overloads IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected overload_count=%', v_overloads;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
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

  IF v_md5 IS DISTINCT FROM '80c738f1ab36c17174bcc98a8416855c' THEN
    RAISE EXCEPTION 'A8B28 HARD STOP: unexpected proposed md5(prosrc)=%', v_md5;
  END IF;

  IF has_function_privilege('anon', 'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'A8B28 HARD STOP: PUBLIC/anon EXECUTE present';
  END IF;
END $$;

COMMIT;
