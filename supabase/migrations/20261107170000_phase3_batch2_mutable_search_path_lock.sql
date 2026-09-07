-- ============================================================
-- Phase 3 Batch 2: fix mutable search_path on four INVOKER helpers
-- NOT APPLIED until explicitly approved.
--
-- Scope (exact signatures, no overloads):
--   public.payout_ledger_type_is_payout_eligible(text)
--   public.scrub_campaign_heads_up_taxi_branding()
--   public.driver_wallet_captured_at_restamp_suspect(timestamptz, timestamptz, timestamptz)
--   public.driver_wallet_stable_clearing_origin(timestamptz, timestamptz, timestamptz, timestamptz, timestamptz)
--
-- Method: ALTER FUNCTION … SET search_path only.
-- Does NOT replace bodies, change volatility, SECURITY mode, or ACLs.
-- Narrowest safe path: pg_catalog (builtins only; public refs already schema-qualified).
-- Matches prior P0 pattern in 20260831120200 for payout_ledger_type_is_payout_eligible.
-- ============================================================

BEGIN;

ALTER FUNCTION public.payout_ledger_type_is_payout_eligible(text)
  SET search_path TO pg_catalog;

ALTER FUNCTION public.scrub_campaign_heads_up_taxi_branding()
  SET search_path TO pg_catalog;

ALTER FUNCTION public.driver_wallet_captured_at_restamp_suspect(
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone
) SET search_path TO pg_catalog;

ALTER FUNCTION public.driver_wallet_stable_clearing_origin(
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone,
  timestamp with time zone
) SET search_path TO pg_catalog;

COMMIT;
