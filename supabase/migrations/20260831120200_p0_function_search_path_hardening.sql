-- P0: Pin search_path on the 11 advisor-flagged mutable functions.
-- Pure SQL / trigger bodies use pg_catalog only; trip fare helpers need public for typed args + peers.
-- Rollback (manual only, NOT a migration): supabase/rollback/p0_security_hardening_rollback_20260831.sql

ALTER FUNCTION public.enforce_negotiation_pre_hold_assignment()
  SET search_path = pg_catalog;

ALTER FUNCTION public.driver_wallet_provider_funds_cleared(text)
  SET search_path = pg_catalog;

ALTER FUNCTION public.is_scheduled_instant_conversion_pending(text, text, boolean, timestamptz)
  SET search_path = pg_catalog;

ALTER FUNCTION public.trg_payout_item_ledger_allocations_immutable()
  SET search_path = pg_catalog;

ALTER FUNCTION public.payout_item_status_releases_ledger_allocation(text, text)
  SET search_path = pg_catalog;

ALTER FUNCTION public.payout_ledger_type_is_payout_eligible(text)
  SET search_path = pg_catalog;

ALTER FUNCTION public.resolve_trip_locked_promotion_pence(public.trips)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.trip_promotion_superseded_by_negotiation(public.trips)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(public.trips)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(public.trips, integer)
  SET search_path = pg_catalog, public;

ALTER FUNCTION public.resolve_trip_commissionable_fare_pence(public.trips, integer, integer, integer)
  SET search_path = pg_catalog, public;
