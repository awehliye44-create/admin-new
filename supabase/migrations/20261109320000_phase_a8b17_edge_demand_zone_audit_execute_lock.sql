-- ============================================================
-- Phase A8B17: ACL-lock one authenticated SECURITY DEFINER
-- demand-zone audit helper (Edge service-only).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; retain
--                    service_role + postgres owner EXECUTE):
--   log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text)
--     ← Edge compute-driver-demand-zones via SUPABASE_SERVICE_ROLE_KEY
--     Gate: requireDemandZoneRecomputeAuth
--       (assertCronOrServiceRoleAuth OR staff demand_zones.recompute)
--     RPC client is always service_role (never user-scoped PostgREST)
--     No Admin/Customer/Driver/Corporate/Guest direct .rpc caller
--     No SQL parent / trigger / RLS / view / cron caller
--
-- Explicitly excluded / HARD_STOP this phase:
--   Mounted JWT: admin_*, driver_request_*, *_own_*, heartbeat,
--     document eligibility, queued trips, passenger map, corporate RPCs,
--     active_super_admin_count, can_driver_edit_vehicle,
--     require_authenticated_driver_id, find_nearby_drivers,
--     get_trip_driver_details, upsert_driver_presence, …
--   RLS helpers: has_role, can_passenger_*, can_corporate_*, is_driver, …
--   Finance / wallet / CW / Revolut / payout / fare helpers
--   Notification/Vault / record_booking_delivery /
--     ride_offer_enqueue_reminders / ride_offer_dispatch_push_delivery
--   resolve_zone_surge / search_onecab_location_landmarks /
--     is_location_search_ssot_enabled / search_places
--   force_driver_offline / submit_driver_location_sample / A8B13D path
--   get_trip_passenger_details
--   Active trip/offer/scheduled/waiting/rematch lifecycle without proof
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 117 → 116 (−1)
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

-- Body hash at draft time (md5(prosrc)):
--   log_demand_zone_event: 981c5d6050a4de8a5c247c0d9ec346ee

REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM authenticated;

-- Explicitly retain service_role EXECUTE for proven Edge service caller.
GRANT EXECUTE ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) TO service_role;
-- Retain postgres owner EXECUTE (implicit via ownership).

COMMIT;
