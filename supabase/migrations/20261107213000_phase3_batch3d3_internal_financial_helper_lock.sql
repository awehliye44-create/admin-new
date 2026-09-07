-- ============================================================
-- Phase 3 Batch 3D3: internal financial helper EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Trigger/Edge/internal helpers. Nested definer callers keep postgres EXECUTE.
-- ACL only unless this file explicitly replaces generate_invoice_number.
-- Does not touch record_cash_trip_completion.
-- Nested SECURITY DEFINER / trigger callers keep postgres EXECUTE.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.recalculate_driver_wallet(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_driver_wallet(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_driver_wallet(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_wallet(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.refresh_driver_wallet_reservation_cache(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_driver_wallet_reservation_cache(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.refresh_driver_wallet_reservation_cache(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_driver_wallet_reservation_cache(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.next_trip_invoice_number() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_trip_invoice_number() FROM anon;
REVOKE ALL ON FUNCTION public.next_trip_invoice_number() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.next_trip_invoice_number() TO service_role;

REVOKE ALL ON FUNCTION public.release_invoice_smoke_send_slot(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_invoice_smoke_send_slot(text) FROM anon;
REVOKE ALL ON FUNCTION public.release_invoice_smoke_send_slot(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_invoice_smoke_send_slot(text) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO service_role;
COMMIT;
