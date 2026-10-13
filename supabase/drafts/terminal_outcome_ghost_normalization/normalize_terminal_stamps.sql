-- TERMINAL OUTCOME STAMP NORMALIZATION — MK-260927-009, MK-261002-014, MK-261002-015
-- PREPARED ONLY. DO NOT RUN WITHOUT EXPLICIT APPROVAL.
--
-- Rewrites the obsolete booking-quote stamp (500 / 75 / 425, 15%) on three terminal trips to
-- the certified terminal projection (buildTerminalOutcomeTripPatch):
--   capture − commission 0 − ACTUAL provider fee = driver net
-- Trip-row projection only. NO wallet movement, NO TRIP_EARNING_NET, NO capture, NO release,
-- NO driver credit/debit, NO commission ledger entry.
--
-- Guards (abort on ANY difference):
--   * every touched column, identity, lifecycle and updated_at equals the exact production values
--     read on 2026-10-02 (read-only snapshot)
--   * exactly one TRIP_EARNING_NET per trip with the certified amount, to the certified driver
--   * captured payment session with captured / ACTUAL fee as certified
--   * fingerprint (row count + md5 of all rows) of every money table identical before and after
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE _norm_money_fp (tbl text PRIMARY KEY, n bigint, h text) ON COMMIT DROP;
CREATE TEMP TABLE _norm_target (
  trip_code text PRIMARY KEY, trip_id uuid, beneficiary uuid, outcome text, status text,
  old_updated_at timestamptz, captured int, fee int, net int
) ON COMMIT DROP;

INSERT INTO _norm_target VALUES
  ('MK-260927-009', '168c3cd6-a657-41fe-ba9d-faed90594dc4', 'c40dd8a6-f422-40bc-9534-bae7be88b93e',
   'ARRIVAL_CANCELLATION', 'cancelled', '2026-10-02T16:20:39.680908+00:00', 400, 24, 376),
  ('MK-261002-014', '118fe5ef-4e2e-4d48-814f-31b65839225b', 'c40dd8a6-f422-40bc-9534-bae7be88b93e',
   'ARRIVAL_CANCELLATION', 'cancelled', '2026-10-02T12:29:45.023843+00:00', 450, 24, 426),
  ('MK-261002-015', '98cab445-aa22-401a-8aac-e53210990273', '56136f5f-1a3a-4a14-bb23-439b3951415a',
   'NO_SHOW', 'no_show', '2026-10-02T12:43:40.982363+00:00', 450, 24, 426);

CREATE OR REPLACE FUNCTION pg_temp._norm_money_fingerprint()
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

INSERT INTO _norm_money_fp SELECT * FROM pg_temp._norm_money_fingerprint();

-- Guard 1: exact current production values (row-locked).
DO $guard$
DECLARE
  t record; tr record; bad text[] := '{}';
BEGIN
  FOR t IN SELECT * FROM _norm_target ORDER BY trip_code LOOP
    SELECT * INTO tr FROM public.trips WHERE id = t.trip_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'NORM_ABORT % not found', t.trip_code; END IF;
    IF tr.trip_code IS DISTINCT FROM t.trip_code THEN bad := bad || 'trip_code'; END IF;
    IF tr.status IS DISTINCT FROM t.status THEN bad := bad || 'status'; END IF;
    IF tr.financial_outcome IS DISTINCT FROM t.outcome THEN bad := bad || 'financial_outcome'; END IF;
    IF tr.financial_model::text IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN bad := bad || 'financial_model'; END IF;
    IF tr.driver_id IS NOT NULL THEN bad := bad || 'driver_id'; END IF;
    IF tr.confirmed_driver_id IS NOT NULL THEN bad := bad || 'confirmed_driver_id'; END IF;
    IF tr.previous_driver_id IS DISTINCT FROM t.beneficiary THEN bad := bad || 'previous_driver_id'; END IF;
    IF tr.updated_at IS DISTINCT FROM t.old_updated_at THEN bad := bad || 'updated_at'; END IF;
    IF tr.capture_amount_pence IS DISTINCT FROM t.captured THEN bad := bad || 'capture_amount_pence'; END IF;
    IF tr.commission_pct IS DISTINCT FROM 15.00 THEN bad := bad || 'commission_pct'; END IF;
    IF tr.final_fare_pence IS DISTINCT FROM 500 THEN bad := bad || 'final_fare_pence'; END IF;
    IF tr.commissionable_fare_pence IS DISTINCT FROM 500 THEN bad := bad || 'commissionable_fare_pence'; END IF;
    IF tr.commission_pence IS DISTINCT FROM 75 THEN bad := bad || 'commission_pence'; END IF;
    IF tr.driver_net_pence IS DISTINCT FROM 425 THEN bad := bad || 'driver_net_pence'; END IF;
    IF tr.driver_net_before_tip_pence IS DISTINCT FROM 425 THEN bad := bad || 'driver_net_before_tip_pence'; END IF;
    IF tr.driver_total_earnings_pence IS DISTINCT FROM 425 THEN bad := bad || 'driver_total_earnings_pence'; END IF;
    IF tr.airport_charge_pence IS DISTINCT FROM 0 THEN bad := bad || 'airport_charge_pence'; END IF;
    IF tr.tip_pence IS DISTINCT FROM 0 THEN bad := bad || 'tip_pence'; END IF;
    IF tr.tip_amount_pence IS DISTINCT FROM 0 THEN bad := bad || 'tip_amount_pence'; END IF;
    IF tr.driver_tier_commission_percent IS DISTINCT FROM 15 THEN bad := bad || 'driver_tier_commission_percent'; END IF;
    IF tr.gross_fare_pence IS DISTINCT FROM 500 THEN bad := bad || 'gross_fare_pence'; END IF;
    IF tr.provider_fee_pence IS DISTINCT FROM t.fee THEN bad := bad || 'provider_fee_pence'; END IF;
    IF tr.onecab_net_pence IS DISTINCT FROM 75 THEN bad := bad || 'onecab_net_pence'; END IF;
    IF tr.platform_gross_revenue_pence IS DISTINCT FROM 75 THEN bad := bad || 'platform_gross_revenue_pence'; END IF;
    IF tr.platform_net_revenue_pence IS DISTINCT FROM 75 THEN bad := bad || 'platform_net_revenue_pence'; END IF;
    IF tr.settlement_formula_version IS DISTINCT FROM '2' THEN bad := bad || 'settlement_formula_version'; END IF;
    IF tr.platform_promotion_subsidy_pence IS DISTINCT FROM 0 THEN bad := bad || 'platform_promotion_subsidy_pence'; END IF;
    IF tr.discount_source IS NOT NULL THEN bad := bad || 'discount_source'; END IF;
    IF coalesce(tr.offer_discount_pence, 0) <> 0 THEN bad := bad || 'offer_discount_pence'; END IF;
    IF array_length(bad, 1) > 0 THEN
      RAISE EXCEPTION 'NORM_ABORT % current values differ: %', t.trip_code, array_to_string(bad, ',');
    END IF;
  END LOOP;
END $guard$;

-- Guard 2: wallet ledger already holds exactly the certified entitlement (one TEN, right driver).
DO $ledger$
DECLARE t record; n int; amt bigint; drv uuid;
BEGIN
  FOR t IN SELECT * FROM _norm_target ORDER BY trip_code LOOP
    SELECT count(*), sum(amount_pence), min(driver_id::text)::uuid INTO n, amt, drv
    FROM public.driver_wallet_ledger WHERE related_trip_id = t.trip_id AND type = 'TRIP_EARNING_NET';
    IF n <> 1 OR amt IS DISTINCT FROM t.net OR drv IS DISTINCT FROM t.beneficiary THEN
      RAISE EXCEPTION 'NORM_ABORT % ledger TEN differs (count %, amount %, driver %)', t.trip_code, n, amt, drv;
    END IF;
  END LOOP;
END $ledger$;

-- Guard 3: authoritative capture evidence.
DO $session$
DECLARE t record; n int;
BEGIN
  FOR t IN SELECT * FROM _norm_target ORDER BY trip_code LOOP
    SELECT count(*) INTO n FROM public.payment_sessions
    WHERE trip_id = t.trip_id AND captured_amount_pence = t.captured
      AND provider_processing_fee_pence = t.fee AND upper(fee_status::text) = 'ACTUAL';
    IF n <> 1 THEN RAISE EXCEPTION 'NORM_ABORT % capture evidence differs (% matching sessions)', t.trip_code, n; END IF;
  END LOOP;
END $session$;

-- Normalize: only columns whose value changes. Unchanged columns (capture 400/450, provider fee 24,
-- tips 0, airport 0, formula '2') are guarded above and deliberately not written.
UPDATE public.trips tr SET
  commission_pct = 0,
  final_fare_pence = t.captured,
  commissionable_fare_pence = t.captured,
  gross_fare_pence = t.captured,
  commission_pence = 0,
  driver_net_pence = t.net,
  driver_net_before_tip_pence = t.net,
  driver_total_earnings_pence = t.net,
  driver_tier_commission_percent = 0,
  onecab_net_pence = 0,
  platform_gross_revenue_pence = 0,
  platform_net_revenue_pence = 0
FROM _norm_target t
WHERE tr.id = t.trip_id
  AND tr.updated_at = t.old_updated_at
  AND tr.driver_net_pence = 425 AND tr.commission_pence = 75 AND tr.gross_fare_pence = 500;

-- Read-back: exactly the certified projection.
DO $readback$
DECLARE t record; tr record; n int := 0;
BEGIN
  FOR t IN SELECT * FROM _norm_target ORDER BY trip_code LOOP
    SELECT * INTO tr FROM public.trips WHERE id = t.trip_id;
    IF tr.driver_net_pence = t.net AND tr.driver_net_before_tip_pence = t.net AND tr.driver_total_earnings_pence = t.net
       AND tr.commission_pence = 0 AND tr.commission_pct = 0 AND tr.driver_tier_commission_percent = 0
       AND tr.provider_fee_pence = t.fee AND tr.capture_amount_pence = t.captured
       AND tr.final_fare_pence = t.captured AND tr.commissionable_fare_pence = t.captured AND tr.gross_fare_pence = t.captured
       AND tr.onecab_net_pence = 0 AND tr.platform_gross_revenue_pence = 0 AND tr.platform_net_revenue_pence = 0
       AND tr.tip_pence = 0 AND tr.tip_amount_pence = 0 AND tr.airport_charge_pence = 0
       AND tr.settlement_formula_version = '2' AND tr.platform_promotion_subsidy_pence = 0
       AND tr.status = t.status AND tr.financial_outcome = t.outcome AND tr.driver_id IS NULL
       AND tr.confirmed_driver_id IS NULL AND tr.previous_driver_id = t.beneficiary
       AND tr.gross_fare_pence - tr.commission_pence - tr.provider_fee_pence = tr.driver_net_pence THEN
      n := n + 1;
    ELSE
      RAISE EXCEPTION 'NORM_ABORT % read-back mismatch', t.trip_code;
    END IF;
  END LOOP;
  IF n <> 3 THEN RAISE EXCEPTION 'NORM_ABORT expected 3 normalized rows, got %', n; END IF;
  RAISE NOTICE 'NORM_OK 3 trips normalized and read back';
END $readback$;

-- Zero money movement: every money table byte-identical to the pre-update fingerprint.
DO $zero$
DECLARE diff text;
BEGIN
  SELECT string_agg(coalesce(a.tbl, b.tbl), ',') INTO diff
  FROM _norm_money_fp a FULL JOIN pg_temp._norm_money_fingerprint() b ON a.tbl = b.tbl
  WHERE a.n IS DISTINCT FROM b.n OR a.h IS DISTINCT FROM b.h;
  IF diff IS NOT NULL THEN RAISE EXCEPTION 'NORM_ABORT money tables changed: %', diff; END IF;
  RAISE NOTICE 'NORM_OK zero money movement across % tables', (SELECT count(*) FROM _norm_money_fp);
END $zero$;

SELECT tbl, n, h FROM _norm_money_fp ORDER BY tbl;
SELECT trip_code, capture_amount_pence, gross_fare_pence, final_fare_pence, commissionable_fare_pence,
       commission_pence, commission_pct, provider_fee_pence, driver_net_pence, driver_total_earnings_pence,
       onecab_net_pence, status, financial_outcome
FROM public.trips WHERE id IN (SELECT trip_id FROM _norm_target) ORDER BY trip_code;

COMMIT;
