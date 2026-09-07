-- Phase 3 Batch 3D2: cross-account financial read EXECUTE lock verify
-- Transaction-only. Applies this batch, probes, then ROLLBACK.
-- Does not persist ACL, invoice numbers, or financial rows.

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

DO $$
DECLARE
  v_names text[] := ARRAY[
    'get_driver_ledger_aggregates(uuid)',
    'driver_wallet_live_balance_pence(uuid)',
    'driver_wallet_available_for_payout_pence(uuid)',
    'driver_wallet_active_reservation_pence(uuid)',
    'driver_wallet_other_holds_pence(uuid)',
    'driver_wallet_ledger_economic_fields(uuid)',
    'driver_commission_wallet_balance_parts(uuid, uuid)',
    'driver_commission_wallet_usable_balance_minor(uuid, uuid)',
    'get_customer_lifecycle_debt_pence(uuid)',
    'payment_gate_historical_audit()',
    'audit_payment_session_amounts(uuid)',
    'payment_session_action_policy(uuid, jsonb)',
    'assert_payment_gate(uuid)',
    'assert_payment_authorized(uuid)',
    'payment_authorisation_valid(uuid)',
    'compute_driver_net_preview_from_gross(integer, uuid, uuid, integer)',
    'ops_reconciliation_diagnostics()',
    'driver_passes_commission_wallet_dispatch_gate(uuid, uuid)',
    'ride_offer_build_send_notification_body(uuid)'
  ];
  v_sig text;
  v_auth int;
BEGIN
  FOREACH v_sig IN ARRAY v_names LOOP
    IF has_function_privilege('authenticated', ('public.' || v_sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || v_sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('public', ('public.' || v_sig)::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', ('public.' || v_sig)::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('postgres', ('public.' || v_sig)::regprocedure, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'acl mismatch %', v_sig;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_auth <> 268 - 19 THEN
    RAISE EXCEPTION 'auth secdef % expected %', v_auth, 268 - 19;
  END IF;
END $$;

SELECT 'pass' AS status, 19 AS warning_reduction, 268 - 19 AS expected_auth_secdef;
ROLLBACK;
