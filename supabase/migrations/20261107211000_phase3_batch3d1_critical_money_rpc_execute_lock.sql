-- ============================================================
-- Phase 3 Batch 3D1: critical money/state RPC EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Proven service_role Edge or postgres trigger/definer callers only. No Admin/Driver/Customer .rpc().
-- ACL only unless this file explicitly replaces generate_invoice_number.
-- Does not touch record_cash_trip_completion.
-- Nested SECURITY DEFINER / trigger callers keep postgres EXECUTE.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.apply_trip_modification_to_trip(uuid, text, integer, integer, integer, integer, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_trip_modification_to_trip(uuid, text, integer, integer, integer, integer, jsonb, jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.apply_trip_modification_to_trip(uuid, text, integer, integer, integer, integer, jsonb, jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_trip_modification_to_trip(uuid, text, integer, integer, integer, integer, jsonb, jsonb, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.apply_approved_trip_change_from_request(trip_change_requests) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_approved_trip_change_from_request(trip_change_requests) FROM anon;
REVOKE ALL ON FUNCTION public.apply_approved_trip_change_from_request(trip_change_requests) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_approved_trip_change_from_request(trip_change_requests) TO service_role;

REVOKE ALL ON FUNCTION public.advance_trip_change_after_payment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.advance_trip_change_after_payment(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.advance_trip_change_after_payment(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.advance_trip_change_after_payment(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.invoke_release_terminal_trip_hold(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invoke_release_terminal_trip_hold(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.invoke_release_terminal_trip_hold(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_release_terminal_trip_hold(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.insert_payment_release_evidence_backfill(text, uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, text, text, text, timestamp with time zone, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insert_payment_release_evidence_backfill(text, uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, text, text, text, timestamp with time zone, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.insert_payment_release_evidence_backfill(text, uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, text, text, text, timestamp with time zone, jsonb, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.insert_payment_release_evidence_backfill(text, uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, text, text, text, timestamp with time zone, jsonb, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.claim_company_transfer_submission(uuid, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_company_transfer_submission(uuid, text, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.claim_company_transfer_submission(uuid, text, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_company_transfer_submission(uuid, text, uuid, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_company_transfer_completion(uuid, text, text, timestamp with time zone, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_company_transfer_completion(uuid, text, text, timestamp with time zone, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_company_transfer_completion(uuid, text, text, timestamp with time zone, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_company_transfer_completion(uuid, text, text, timestamp with time zone, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_company_transfer_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_company_transfer_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_company_transfer_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_company_transfer_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.sync_company_transfer_provider_status(uuid, text, text, timestamp with time zone, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_company_transfer_provider_status(uuid, text, text, timestamp with time zone, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.sync_company_transfer_provider_status(uuid, text, text, timestamp with time zone, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_company_transfer_provider_status(uuid, text, text, timestamp with time zone, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.release_company_funding_hold(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_company_funding_hold(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.release_company_funding_hold(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_company_funding_hold(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamp with time zone) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.start_stop_waiting(uuid, uuid, uuid, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_stop_waiting(uuid, uuid, uuid, integer, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.start_stop_waiting(uuid, uuid, uuid, integer, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_stop_waiting(uuid, uuid, uuid, integer, integer, integer) TO service_role;

REVOKE ALL ON FUNCTION public.stop_stop_waiting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stop_stop_waiting(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.stop_stop_waiting(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.stop_stop_waiting(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.tick_stop_waiting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tick_stop_waiting(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.tick_stop_waiting(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.tick_stop_waiting(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ops_repair_missing_commission(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_repair_missing_commission(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_repair_missing_commission(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_repair_missing_commission(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.snapshot_accepted_wave_commission(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snapshot_accepted_wave_commission(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.snapshot_accepted_wave_commission(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_accepted_wave_commission(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.snapshot_driver_tier_commission_on_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snapshot_driver_tier_commission_on_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.snapshot_driver_tier_commission_on_trip(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_driver_tier_commission_on_trip(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.consume_personal_voucher(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.consume_personal_voucher(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.consume_personal_voucher(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.consume_personal_voucher(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer) FROM anon;
REVOKE ALL ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer) TO service_role;

REVOKE ALL ON FUNCTION public.ops_replay_webhook(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_replay_webhook(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_replay_webhook(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_replay_webhook(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.sync_payout_item_ledger_debit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_payout_item_ledger_debit(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sync_payout_item_ledger_debit(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_payout_item_ledger_debit(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.release_sub_minimum_weekly_payout_reservations(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_sub_minimum_weekly_payout_reservations(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_sub_minimum_weekly_payout_reservations(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_sub_minimum_weekly_payout_reservations(uuid) TO service_role;
COMMIT;
