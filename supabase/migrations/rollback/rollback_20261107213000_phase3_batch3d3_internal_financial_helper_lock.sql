-- Rollback Phase 3 Batch 3D3: internal financial helper EXECUTE lock. Restores authenticated EXECUTE only. Does not remove any grant.

BEGIN;

GRANT EXECUTE ON FUNCTION public.recalculate_driver_wallet(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_driver_wallet_reservation_cache(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_trip_invoice_number() TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_invoice_smoke_send_slot(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO authenticated;
COMMIT;
