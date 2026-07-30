-- Phase 2C/2D SQL integration checklist + presence probes.
-- Run AFTER applying:
--   20260903130000_driver_cancel_before_start_rematch_atomic.sql
--   20260903131000_phase2c_gap_close_exclusion_accept_paths.sql
--
-- This file is intentionally NOT auto-executed against production.
-- Use against a non-prod branch or after approved migration apply.
-- Replace seed UUIDs with fixtures when running behavioural cases 1-29.

-- ---------------------------------------------------------------------------
-- Presence / schema probes (safe on any DB)
-- ---------------------------------------------------------------------------
SELECT
  to_regprocedure('public.driver_cancel_before_start_rematch(uuid,uuid,text,text,jsonb)') IS NOT NULL AS rematch_rpc_present,
  to_regprocedure('public.driver_is_excluded_from_trip(uuid,uuid)') IS NOT NULL AS exclusion_helper_present,
  to_regclass('public.dispatch_intent_outbox') IS NOT NULL AS outbox_present,
  to_regclass('public.driver_cancel_rematch_idempotency') IS NOT NULL AS idempotency_present,
  to_regclass('public.driver_cancel_rematch_audit') IS NOT NULL AS audit_present,
  to_regprocedure('public.enforce_driver_cancel_rematch_invariants()') IS NOT NULL AS invariant_fn_present,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'ride_offers_one_accepted_per_trip'
  ) AS one_accepted_index_present,
  -- Scan&Go must stay removed (no exception path to reintroduce).
  to_regclass('public.scan_go_driver_holds') IS NULL AS scan_go_holds_absent,
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'trips'
      AND column_name IN ('scan_go', 'qr_session_id')
  ) AS scan_go_trip_cols_absent;

-- ---------------------------------------------------------------------------
-- Behavioural checklist (manual with fixtures)
-- ---------------------------------------------------------------------------
-- 1-5 rematchable statuses (seed trips assigned to driver, then):
-- SELECT public.driver_cancel_before_start_rematch(
--   '<trip_id>', '<driver_id>', 'driver_cancelled', 'idem-1',
--   '{"actor_mode":"service_role","actor":"edge","is_no_show":false}'::jsonb
-- );
-- Expect: ok=true, status=searching_new_driver, dispatch_status=broadcasting
-- Expect: trips.current_broadcast_round unchanged (auto-dispatch owns +1)

-- 6 No-show metadata rejected:
-- ... p_request_metadata := '{"actor_mode":"service_role","is_no_show":true}'
-- Expect: ok=false, error=NO_SHOW_NOT_ALLOWED

-- 7-11 terminal statuses rejected (seed status accordingly)
-- Expect: ok=false, error=INVALID_STATE

-- 12 wrong driver rejected
-- Expect: ok=false, error=FORBIDDEN

-- 13 duplicate idempotency key
-- Call twice with same key; expect idempotent_replay=true and unchanged
-- exclusion count / single audit row for first commit.

-- 13b same idempotency key against different trip_id → CONFLICT

-- 14-15
-- SELECT count(*) FROM trip_driver_exclusions WHERE trip_id=... AND driver_id=...; -- =1
-- SELECT source FROM trip_driver_exclusions ...; -- driver_cancel_before_start
-- SELECT cancelled_driver_ids, excluded_driver_ids FROM trips WHERE id=...;
-- arrays contain driver once only.

-- 16-18
-- confirmed_driver_id IS NULL
-- drivers.current_trip_id IS NULL where matched
-- customers.active_trip_id = trip_id

-- 19-22 finance snapshot equal before/after (fare, payment_intent_id, voucher fields)

-- 23-24 stale arrive/start:
-- UPDATE trips SET status='arrived' WHERE id=... AND confirmed_driver_id IS NULL;
-- Expect: ASSIGNMENT_REQUIRED

-- 25 accept_ride_offer / accept_scheduled_ride / accept_stacked_ride with excluded driver
-- Expect: DRIVER_EXCLUDED / driver_excluded

-- 26 leave outbox failed; trip remains searching_new_driver; soft replay retries

-- 27-28 concurrent customer cancel / start under FOR UPDATE → one winner

-- 29 expired offer acceptance → OFFER_EXPIRED

-- 30 Scan&Go removed — no expire-exception branch; rematch applies uniformly
