-- ============================================================
-- Phase 3 Batch 3D2: cross-account financial read EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Ungated cross-account readers and wrappers. Owner and finance-page RPCs are not revoked.
-- ACL only unless this file explicitly replaces generate_invoice_number.
-- Does not touch record_cash_trip_completion.
-- Nested SECURITY DEFINER / trigger callers keep postgres EXECUTE.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.get_driver_ledger_aggregates(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_ledger_aggregates(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_ledger_aggregates(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_ledger_aggregates(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_live_balance_pence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_live_balance_pence(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_live_balance_pence(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_live_balance_pence(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_active_reservation_pence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_active_reservation_pence(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_active_reservation_pence(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_active_reservation_pence(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_other_holds_pence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_other_holds_pence(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_other_holds_pence(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_other_holds_pence(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_commission_wallet_balance_parts(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_commission_wallet_usable_balance_minor(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_customer_lifecycle_debt_pence(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_lifecycle_debt_pence(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_lifecycle_debt_pence(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_lifecycle_debt_pence(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.payment_gate_historical_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_gate_historical_audit() FROM anon;
REVOKE ALL ON FUNCTION public.payment_gate_historical_audit() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payment_gate_historical_audit() TO service_role;

REVOKE ALL ON FUNCTION public.audit_payment_session_amounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_payment_session_amounts(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.audit_payment_session_amounts(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.audit_payment_session_amounts(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.payment_session_action_policy(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_session_action_policy(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.payment_session_action_policy(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payment_session_action_policy(uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.assert_payment_gate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_payment_gate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_payment_gate(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_payment_gate(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.assert_payment_authorized(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_payment_authorized(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_payment_authorized(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assert_payment_authorized(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.payment_authorisation_valid(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.compute_driver_net_preview_from_gross(integer, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_driver_net_preview_from_gross(integer, uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.compute_driver_net_preview_from_gross(integer, uuid, uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.compute_driver_net_preview_from_gross(integer, uuid, uuid, integer) TO service_role;

REVOKE ALL ON FUNCTION public.ops_reconciliation_diagnostics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_reconciliation_diagnostics() FROM anon;
REVOKE ALL ON FUNCTION public.ops_reconciliation_diagnostics() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_reconciliation_diagnostics() TO service_role;

REVOKE ALL ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_passes_commission_wallet_dispatch_gate(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ride_offer_build_send_notification_body(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_build_send_notification_body(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_build_send_notification_body(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_build_send_notification_body(uuid) TO service_role;
COMMIT;
