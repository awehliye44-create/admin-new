-- Phase 3 Batch 3C — transaction-only privilege matrix.
-- Applies the Batch 3C REVOKEs inside this transaction, probes, then ROLLBACK.
-- Does not call accept, decline, dispatch, cancel, finalize, or wallet RPCs.

BEGIN;

REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_ride_offer(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_ride_offer(uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_paid_booking_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_booking_session(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) TO service_role;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'accept_ride_offer(uuid, uuid, boolean)',
    'decline_ride_offer(uuid, uuid)',
    'decline_ride_offer(uuid, uuid, text)',
    'commit_dispatch_wave(uuid, integer, jsonb, integer)',
    'commit_negotiation_fare(uuid, integer, text, uuid, uuid)',
    'complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone)',
    'apply_terminal_trip_cancellation(uuid, text, text)',
    'finalize_paid_booking_session(uuid)',
    'accept_stacked_ride(uuid, uuid, uuid)',
    'customer_counter_ride_offer(uuid, integer, uuid, uuid)',
    'driver_accept_counter_offer(uuid, uuid)',
    'finalize_negotiated_fare(uuid, uuid, integer, text, uuid)',
    'finalize_negotiation_failure(uuid, uuid, uuid, text, text)'
  ];
  v_sig text;
  v_oid oid;
  v_auth int;
  v_offers bigint;
  v_trips bigint;
BEGIN
  SELECT count(*) INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_auth <> 304 - array_length(v_names, 1) THEN
    RAISE EXCEPTION 'FAIL auth SECDEF % expected %', v_auth, 304 - array_length(v_names, 1);
  END IF;

  FOREACH v_sig IN ARRAY v_names LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'missing %', v_sig;
    END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL client EXECUTE remains on %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('postgres', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL trusted EXECUTE lost on %', v_sig;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_offers FROM public.ride_offers;
  SELECT count(*) INTO v_trips FROM public.trips;
  IF v_offers IS NULL OR v_trips IS NULL THEN
    RAISE EXCEPTION 'FAIL counts';
  END IF;
END $$;

SELECT 'pass' AS status;

ROLLBACK;
