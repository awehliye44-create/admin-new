-- Rollback Phase 3 Batch 3D1: critical money/state RPC EXECUTE lock. Restores authenticated EXECUTE only. Does not remove any grant.

BEGIN;

GRANT EXECUTE ON FUNCTION public.apply_trip_modification_to_trip(uuid, text, integer, integer, integer, integer, jsonb, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_approved_trip_change_from_request(trip_change_requests) TO authenticated;
GRANT EXECUTE ON FUNCTION public.advance_trip_change_after_payment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.convert_driver_commission_wallet_on_trip_complete(uuid, uuid, integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_release_terminal_trip_hold(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_payment_release_evidence_backfill(text, uuid, uuid, text, text, text, integer, integer, integer, integer, text, text, text, text, text, timestamp with time zone, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_company_transfer_submission(uuid, text, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_company_transfer_completion(uuid, text, text, timestamp with time zone, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_company_transfer_submission(uuid, uuid, text, text, text, timestamp with time zone, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_company_transfer_provider_status(uuid, text, text, timestamp with time zone, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_company_funding_hold(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_company_transfer_payment_reference(text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_stop_waiting(uuid, uuid, uuid, integer, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_stop_waiting(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tick_stop_waiting(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_repair_missing_commission(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_accepted_wave_commission(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_driver_tier_commission_on_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_personal_voucher(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_replay_webhook(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_payout_item_ledger_debit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_sub_minimum_weekly_payout_reservations(uuid) TO authenticated;
COMMIT;
