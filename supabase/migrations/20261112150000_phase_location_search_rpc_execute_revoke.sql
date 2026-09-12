-- ============================================================
-- Authenticated SECURITY DEFINER ACL lock for two location-search
-- helpers. Grants/revokes only. Does not change bodies, owners,
-- SECURITY DEFINER, volatility, or search_path. Does not invoke
-- any function.
--
-- EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; keep service_role):
--   search_places(q text, p_service_area_id uuid, p_limit integer)
--     sole caller: place-lookup Edge, client built from
--     SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY.
--     anon EXECUTE is already false, so the anon fallback cannot
--     succeed today. No app .rpc. No SQL/view/trigger/cron parent.
--   search_onecab_location_landmarks(p_query text, p_service_area_id uuid,
--     p_country_code text, p_region_id uuid, p_limit integer)
--     sole source caller: customer-native search-onecab-locations,
--     createClient(url, SUPABASE_SERVICE_ROLE_KEY).
--     Live admin-new search-onecab-locations does not call this RPC.
--     No app .rpc. No SQL/view/trigger/cron parent.
--
-- Body hashes at apply time (md5(prosrc)):
--   search_places: 61b8c51a24efd25a93013ec8b063cefb
--   search_onecab_location_landmarks: 48f9f4a4c403fe76ee2962ee87ed5c56
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 109 → 107 (−2)
--   anon remains 0
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.search_places(text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_places(text, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.search_places(text, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.search_places(text, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.search_onecab_location_landmarks(text, uuid, text, uuid, integer) TO service_role;

COMMIT;
