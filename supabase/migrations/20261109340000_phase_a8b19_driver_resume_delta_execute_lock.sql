-- ============================================================
-- Phase A8B19: ACL-lock authenticated SECURITY DEFINER
-- get_driver_resume_delta (proven ORPHANED lifecycle hint RPC).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, search_path, or app/Edge change.
--
-- ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--   get_driver_resume_delta(timestamptz, uuid, uuid)
--     Defaults: p_since_server_ts NULL, p_known_active_trip_id NULL,
--               p_known_offer_id NULL
--     Read-only STABLE hint: returns cursor/server_time/changed_domains/
--       current_trip_id/active_offer_id for auth.uid()-bound driver only
--     No live Driver/Customer/Admin/Corporate/Guest/Edge .rpc caller
--     Not listed in Driver contracts.ts
--     No SQL parent / trigger / RLS / view / cron
--     Live resume SSOT is domain hydrates (unchanged this phase):
--       get_driver_active_trip_snapshot, get_driver_pending_ride_offers,
--       get_driver_queued_trips, list_driver_own_scheduled_jobs,
--       presence heartbeat / go-online, wallet/docs screen RPCs
--
-- Explicitly excluded / HARD_STOP this phase:
--   No changes to active-trip, offer, scheduled, waiting, presence,
--     or resume workflows; no Driver app / A8B13D / finance / notify
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 111 → 110 (−1)
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

-- Body hash at draft time (md5(prosrc)):
--   get_driver_resume_delta: e67909a7cb847acbb686306b54ff5b59

REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM service_role;

-- Retain postgres owner EXECUTE (implicit via ownership).

COMMIT;
