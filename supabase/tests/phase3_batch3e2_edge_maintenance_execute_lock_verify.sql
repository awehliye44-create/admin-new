-- 3E2 ACL simulation only. Applies the draft matrix, probes, then ROLLBACK.
-- Does not execute the eight functions. No Edge, network, or provider call.

BEGIN;

REVOKE ALL ON FUNCTION public.expire_stale_offers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_offers() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_offers() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_offers() TO service_role;

REVOKE ALL ON FUNCTION public.expire_trip_when_search_exhausted(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_trip_when_search_exhausted(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.expire_trip_when_search_exhausted(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_trip_when_search_exhausted(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM anon;
REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_ride_offer_ack_timeouts() TO service_role;

REVOKE ALL ON FUNCTION public.lost_property_expire_chats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_expire_chats() FROM anon;
REVOKE ALL ON FUNCTION public.lost_property_expire_chats() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_expire_chats() TO service_role;

REVOKE ALL ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() FROM anon;
REVOKE ALL ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() TO service_role;

REVOKE ALL ON FUNCTION public.expire_due_call_masking_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_due_call_masking_sessions() FROM anon;
REVOKE ALL ON FUNCTION public.expire_due_call_masking_sessions() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_due_call_masking_sessions() TO service_role;

REVOKE ALL ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) FROM anon;
REVOKE ALL ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) TO service_role;

REVOKE ALL ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) TO service_role;

DO $$
DECLARE
  v_name text;
  v_auth int := 0;
  v_anon int := 0;
  v_public int := 0;
  v_pg_missing int := 0;
  v_svc_missing int := 0;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'public.expire_stale_offers()',
    'public.expire_trip_when_search_exhausted(uuid)',
    'public.process_ride_offer_ack_timeouts()',
    'public.lost_property_expire_chats()',
    'public.lost_property_get_cases_for_photo_cleanup()',
    'public.expire_due_call_masking_sessions()',
    'public.ops_auto_resolve_stale_alerts(integer)',
    'public.timeout_scheduled_offer(uuid, uuid)'
  ]
  LOOP
    IF has_function_privilege('authenticated', v_name::regprocedure, 'EXECUTE') THEN
      v_auth := v_auth + 1;
    END IF;
    IF has_function_privilege('anon', v_name::regprocedure, 'EXECUTE') THEN
      v_anon := v_anon + 1;
    END IF;
    IF has_function_privilege('public', v_name::regprocedure, 'EXECUTE') THEN
      v_public := v_public + 1;
    END IF;
    IF has_function_privilege('postgres', v_name::regprocedure, 'EXECUTE') IS NOT TRUE THEN
      v_pg_missing := v_pg_missing + 1;
    END IF;
    IF has_function_privilege('service_role', v_name::regprocedure, 'EXECUTE') IS NOT TRUE THEN
      v_svc_missing := v_svc_missing + 1;
    END IF;
  END LOOP;

  IF v_auth <> 0 OR v_anon <> 0 OR v_public <> 0 OR v_pg_missing <> 0 OR v_svc_missing <> 0 THEN
    RAISE EXCEPTION '3e2 acl failed auth=% anon=% public=% pg_missing=% svc_missing=%',
      v_auth, v_anon, v_public, v_pg_missing, v_svc_missing;
  END IF;
END $$;

SELECT
  (SELECT count(*)
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef_inside_txn,
  has_function_privilege('authenticated', 'public.expire_stale_offers()'::regprocedure, 'EXECUTE') AS auth_offers,
  has_function_privilege('service_role', 'public.expire_stale_offers()'::regprocedure, 'EXECUTE') AS svc_offers,
  has_function_privilege('service_role', 'public.expire_trip_when_search_exhausted(uuid)'::regprocedure, 'EXECUTE') AS svc_search,
  has_function_privilege('service_role', 'public.process_ride_offer_ack_timeouts()'::regprocedure, 'EXECUTE') AS svc_ack,
  has_function_privilege('service_role', 'public.lost_property_expire_chats()'::regprocedure, 'EXECUTE') AS svc_chats,
  has_function_privilege('service_role', 'public.lost_property_get_cases_for_photo_cleanup()'::regprocedure, 'EXECUTE') AS svc_photos,
  has_function_privilege('service_role', 'public.expire_due_call_masking_sessions()'::regprocedure, 'EXECUTE') AS svc_masking,
  has_function_privilege('service_role', 'public.ops_auto_resolve_stale_alerts(integer)'::regprocedure, 'EXECUTE') AS svc_alerts,
  has_function_privilege('service_role', 'public.timeout_scheduled_offer(uuid, uuid)'::regprocedure, 'EXECUTE') AS svc_timeout,
  has_function_privilege('postgres', 'public.timeout_scheduled_offer(uuid, uuid)'::regprocedure, 'EXECUTE') AS pg_timeout;

ROLLBACK;
