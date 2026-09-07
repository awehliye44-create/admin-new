-- Phase 3 Batch 3D3: internal financial helper EXECUTE lock verify
-- Transaction-only. Applies this batch, probes, then ROLLBACK.
-- Does not persist ACL, invoice numbers, or financial rows.

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

DO $$
DECLARE
  v_names text[] := ARRAY[
    'recalculate_driver_wallet(uuid)',
    'refresh_driver_wallet_reservation_cache(uuid)',
    'ensure_driver_commission_wallet_account(uuid, uuid, text)',
    'next_trip_invoice_number()',
    'release_invoice_smoke_send_slot(text)',
    'driver_wallet_payout_clearing_delay_hours()'
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

  IF v_auth <> 249 - 6 THEN
    RAISE EXCEPTION 'auth secdef % expected %', v_auth, 249 - 6;
  END IF;
END $$;

SELECT 'pass' AS status, 6 AS warning_reduction, 249 - 6 AS expected_auth_secdef;
ROLLBACK;
