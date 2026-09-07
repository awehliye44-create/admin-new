-- Rollback Phase 3 Batch 3D2: cross-account financial read EXECUTE lock. Restores authenticated EXECUTE only. Does not remove any grant.

BEGIN;

GRANT EXECUTE ON FUNCTION public.get_driver_ledger_aggregates(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_live_balance_pence(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_active_reservation_pence(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_other_holds_pence(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_lifecycle_debt_pence(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payment_gate_historical_audit() TO authenticated;
GRANT EXECUTE ON FUNCTION public.audit_payment_session_amounts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payment_session_action_policy(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_payment_gate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_payment_authorized(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_driver_net_preview_from_gross(integer, uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_reconciliation_diagnostics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_build_send_notification_body(uuid) TO authenticated;
COMMIT;
