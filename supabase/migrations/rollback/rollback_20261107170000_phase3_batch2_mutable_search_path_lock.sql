-- EMERGENCY ROLLBACK for 20261107170000_phase3_batch2_mutable_search_path_lock.sql
-- Restores pre-Batch2 mutable search_path (RESET) — reopens Advisor warnings.

BEGIN;

ALTER FUNCTION public.payout_ledger_type_is_payout_eligible(text)
  RESET search_path;

ALTER FUNCTION public.scrub_campaign_heads_up_taxi_branding()
  RESET search_path;

ALTER FUNCTION public.driver_wallet_captured_at_restamp_suspect(
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone
) RESET search_path;

ALTER FUNCTION public.driver_wallet_stable_clearing_origin(
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone
) RESET search_path;

COMMIT;
