-- Hotfix: WhatsApp / guest booking finalize aborted after Revolut AUTHORISED.
--
-- Root cause (2026-11-17 production):
--   apply_consumed_server_fare_airport_split_to_trip joined
--     booking_payment_quotes.client_action_id (uuid)
--     = payment_sessions.client_action_id (text)
--   → ERROR: operator does not exist: uuid = text
--
-- finalize_paid_booking_session calls that helper in the same transaction as
-- trips INSERT, so the trip never commits while the Revolut hold stays
-- payment_authorised. Customer sees money taken, no booking.
--
-- Evidence: payment_sessions 378650e6… / 7994057e… —
--   status=payment_authorised, provider_state=AUTHORISED, trip_id NULL,
--   metadata.last_auto_recovery_error = 'operator does not exist: uuid = text'
--
-- Fix: compare via text cast. Do not invent airport amounts.

DO $patch$
DECLARE
  v_def text;
  v_old text := 'WHERE bpq.client_action_id = ps.client_action_id';
  v_new text := 'WHERE bpq.client_action_id::text = ps.client_action_id';
BEGIN
  SELECT pg_get_functiondef(
    'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      'apply_consumed_server_fare_airport_split_to_trip missing — apply 20270219120000 first';
  END IF;

  -- Already patched (idempotent).
  IF position(v_new in v_def) > 0 THEN
    RAISE NOTICE 'airport split client_action_id cast already present';
    RETURN;
  END IF;

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION
      'airport split client_action_id join marker not found — abort (function body drifted)';
  END IF;

  -- PG15-compatible replace (3-arg only). Do not use replace(..., occurrence)
  -- — that form requires PG16+ and breaks CI migration gates.
  v_def := replace(v_def, 'CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END;
$patch$;
