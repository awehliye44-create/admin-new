-- ============================================================
-- Phase A8B16: ACL-lock two authenticated SECURITY DEFINER
-- driver alert helpers (postgres-internal only).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role;
--                         postgres owner EXECUTE retained):
--   raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb)
--     ← detect_driver_problems (cron detect_driver_problems_60s)
--     ← record_driver_commitment_warning
--   resolve_driver_alert(uuid, text)
--     ← detect_driver_problems
--     ← stop_driver_commitment_session
--   Parents are postgres-owned SECURITY DEFINER; cron executes as
--   postgres. Nested owner EXECUTE preserves the chain after revoke.
--   Body privileged path allows current_user postgres/supabase_admin.
--
-- Explicitly excluded / HARD_STOP this phase:
--   Mounted JWT workflows (admin_*, driver_request_*, *_own_*, heartbeat,
--     document eligibility, queued trips, passenger map, corporate RPCs)
--   RLS helpers (has_role, can_passenger_*, can_corporate_*, is_driver, …)
--   require_authenticated_driver_id (driver logout JWT RPC)
--   can_driver_edit_vehicle (driver profile JWT RPC)
--   find_nearby_drivers (central-hub JWT RPC)
--   upsert_driver_presence / update_driver_location / force_driver_offline /
--     submit_driver_location_sample (A8B13D / live location)
--   record_booking_delivery (Edge + authenticated userClient path)
--   Finance / wallet / CW / Revolut / payout helpers
--   Notification/Vault / ride_offer_enqueue_reminders /
--     ride_offer_dispatch_push_delivery
--   resolve_zone_surge — Edge service_role callers exist, but calculate-fare /
--     estimate-fare use verify_jwt=false with no in-function auth gate
--   search_onecab_location_landmarks — live search-onecab-locations reads the
--     table; customer-native mirror RPC path is non-deployed / ambiguous
--   is_location_search_ssot_enabled — authenticated admin + guest callers
--   admin_get_user_email — used by admin_riders view path / PII
--   active_super_admin_count — Admin web useRoleCapabilities JWT RPC
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 119 → 117 (−2)
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   raise_driver_alert: 37de48bae4231106a30e32c49fe3dacd
--   resolve_driver_alert: 648a13b0f8de4e35f836676afe9b21e2

REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM service_role;

COMMIT;
