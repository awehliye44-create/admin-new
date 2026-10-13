-- ROLLBACK for normalize_terminal_stamps.sql — restores the pre-normalization trip stamps of
-- MK-260927-009, MK-261002-014, MK-261002-015 exactly (booking quote 500 / 75 / 425, 15%).
-- Guarded against the normalized values; aborts on any difference.
-- Trip-row projection only. NO wallet / ledger / payment / commission writes.
-- updated_at cannot be restored: the update_trips_updated_at trigger stamps now().
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE _rb_money_fp (tbl text PRIMARY KEY, n bigint, h text) ON COMMIT DROP;
CREATE TEMP TABLE _rb_target (trip_code text PRIMARY KEY, trip_id uuid, beneficiary uuid, captured int, net int) ON COMMIT DROP;
INSERT INTO _rb_target VALUES
  ('MK-260927-009', '168c3cd6-a657-41fe-ba9d-faed90594dc4', 'c40dd8a6-f422-40bc-9534-bae7be88b93e', 400, 376),
  ('MK-261002-014', '118fe5ef-4e2e-4d48-814f-31b65839225b', 'c40dd8a6-f422-40bc-9534-bae7be88b93e', 450, 426),
  ('MK-261002-015', '98cab445-aa22-401a-8aac-e53210990273', '56136f5f-1a3a-4a14-bb23-439b3951415a', 450, 426);

CREATE OR REPLACE FUNCTION pg_temp._rb_money_fingerprint()
RETURNS TABLE (tbl text, n bigint, h text) LANGUAGE plpgsql AS $fp$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind = 'r'
      AND c.relname ~ '(ledger|wallet|payout|payment_session|settlement|commission|finance|refund|receivable|adjustment|transfer|cashout)'
    ORDER BY 1
  LOOP
    tbl := r.relname;
    EXECUTE format(
      'SELECT count(*), md5(coalesce(string_agg(t::text, ''|'' ORDER BY t::text), '''')) FROM public.%I t',
      r.relname) INTO n, h;
    RETURN NEXT;
  END LOOP;
END $fp$;
INSERT INTO _rb_money_fp SELECT * FROM pg_temp._rb_money_fingerprint();

DO $guard$
DECLARE t record; tr record;
BEGIN
  FOR t IN SELECT * FROM _rb_target ORDER BY trip_code LOOP
    SELECT * INTO tr FROM public.trips WHERE id = t.trip_id FOR UPDATE NOWAIT;
    IF NOT (tr.driver_net_pence = t.net AND tr.driver_net_before_tip_pence = t.net AND tr.driver_total_earnings_pence = t.net
       AND tr.commission_pence = 0 AND tr.commission_pct = 0 AND tr.driver_tier_commission_percent = 0
       AND tr.gross_fare_pence = t.captured AND tr.final_fare_pence = t.captured AND tr.commissionable_fare_pence = t.captured
       AND tr.capture_amount_pence = t.captured AND tr.provider_fee_pence = 24
       AND tr.onecab_net_pence = 0 AND tr.platform_gross_revenue_pence = 0 AND tr.platform_net_revenue_pence = 0
       AND tr.driver_id IS NULL AND tr.previous_driver_id = t.beneficiary) THEN
      RAISE EXCEPTION 'ROLLBACK_ABORT % is not in the normalized state', t.trip_code;
    END IF;
  END LOOP;
END $guard$;

UPDATE public.trips tr SET
  commission_pct = 15.00,
  final_fare_pence = 500,
  commissionable_fare_pence = 500,
  gross_fare_pence = 500,
  commission_pence = 75,
  driver_net_pence = 425,
  driver_net_before_tip_pence = 425,
  driver_total_earnings_pence = 425,
  driver_tier_commission_percent = 15,
  onecab_net_pence = 75,
  platform_gross_revenue_pence = 75,
  platform_net_revenue_pence = 75
FROM _rb_target t
WHERE tr.id = t.trip_id AND tr.driver_net_pence = t.net AND tr.commission_pence = 0;

DO $check$
DECLARE n int; diff text;
BEGIN
  SELECT count(*) INTO n FROM public.trips
  WHERE id IN (SELECT trip_id FROM _rb_target)
    AND driver_net_pence = 425 AND commission_pence = 75 AND gross_fare_pence = 500 AND commission_pct = 15.00;
  IF n <> 3 THEN RAISE EXCEPTION 'ROLLBACK_ABORT expected 3 restored rows, got %', n; END IF;
  SELECT string_agg(coalesce(a.tbl, b.tbl), ',') INTO diff
  FROM _rb_money_fp a FULL JOIN pg_temp._rb_money_fingerprint() b ON a.tbl = b.tbl
  WHERE a.n IS DISTINCT FROM b.n OR a.h IS DISTINCT FROM b.h;
  IF diff IS NOT NULL THEN RAISE EXCEPTION 'ROLLBACK_ABORT money tables changed: %', diff; END IF;
  RAISE NOTICE 'ROLLBACK_OK 3 trips restored, zero money movement';
END $check$;

COMMIT;
