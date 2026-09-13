-- DRAFT verification only. This file must be run inside an open transaction
-- that ends in ROLLBACK. It contains no COMMIT. Do not run it with
-- psql --single-transaction (that wrapper commits).
--
-- Touches a TEMP table only. Does not INSERT into public.trips or public.ride_offers.
-- The stamp function SELECTs existing trip rows. MK-260913-002 is not updated.

\set ON_ERROR_STOP on
BEGIN;
\set ON_ERROR_STOP off

SELECT current_setting('transaction_isolation') AS isolation,
       txid_current() IS NOT NULL AS in_transaction;

\i supabase/migrations/20261112170000_airport_charge_offer_stamp.sql

CREATE TEMP TABLE IF NOT EXISTS stamp_evidence (
  case_name text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text NOT NULL
);

INSERT INTO stamp_evidence (case_name, ok, detail)
SELECT 'function_parsed',
       pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure)
         LIKE '%fare_breakdown->>''airportCharge''%'
       AND pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure)
         LIKE '%resolve_wave_commission_percent(v_wave, 0)%'
       AND pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure)
         LIKE '%IF NEW.status IS DISTINCT FROM ''pending''%'
       AND pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure)
         LIKE '%IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW%',
       'parsed replacement contains quote fallback, wave helper, pending skip, stacked skip';

INSERT INTO stamp_evidence (case_name, ok, detail)
SELECT 'no_notify_or_http',
       pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure)
         !~* 'pg_notify|net\.http|http_post|ride_offer_dispatch_push|PERFORM public\.',
       'replacement body has no notify or HTTP call';

INSERT INTO stamp_evidence (case_name, ok, detail)
SELECT 'no_hardcoded_airport_or_rate',
       pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure) !~ '\m700\M'
       AND pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure) !~ '\m15\M',
       'replacement body has no 700 or 15 literal';

DO $json$
DECLARE
  v_src text := pg_get_functiondef('public.tr_stamp_offer_presets_fn()'::regprocedure);
  v_airport integer := 0;
  v_raw numeric;
  v_breakdown jsonb := '{"airportCharge": 4.5}'::jsonb;
BEGIN
  IF v_src NOT LIKE '%fare_breakdown->>''airportCharge''%' THEN
    INSERT INTO stamp_evidence VALUES ('json_fallback', false, 'source missing airportCharge extract');
    RETURN;
  END IF;
  IF v_airport <= 0 AND v_breakdown IS NOT NULL THEN
    v_raw := NULLIF(v_breakdown->>'airport_charge_pence', '')::numeric;
    IF v_raw IS NULL OR v_raw <= 0 THEN
      v_raw := COALESCE(
        NULLIF(v_breakdown->>'airportCharge', '')::numeric,
        NULLIF(v_breakdown->>'airport_charge', '')::numeric,
        0
      );
      IF v_raw > 0 THEN
        v_raw := round(v_raw * 100);
      END IF;
    END IF;
    v_airport := GREATEST(0, round(COALESCE(v_raw, 0)));
  END IF;
  IF v_airport <> 450 THEN
    INSERT INTO stamp_evidence VALUES ('json_fallback', false, 'major units ' || v_airport::text);
    RETURN;
  END IF;

  v_breakdown := '{"airportCharge": 100}'::jsonb;
  v_airport := 0;
  v_raw := NULL;
  IF v_airport <= 0 AND v_breakdown IS NOT NULL THEN
    v_raw := NULLIF(v_breakdown->>'airport_charge_pence', '')::numeric;
    IF v_raw IS NULL OR v_raw <= 0 THEN
      v_raw := COALESCE(
        NULLIF(v_breakdown->>'airportCharge', '')::numeric,
        NULLIF(v_breakdown->>'airport_charge', '')::numeric,
        0
      );
      IF v_raw > 0 THEN
        v_raw := round(v_raw * 100);
      END IF;
    END IF;
    v_airport := GREATEST(0, round(COALESCE(v_raw, 0)));
  END IF;
  IF v_airport <> 10000 THEN
    INSERT INTO stamp_evidence VALUES ('json_fallback', false, 'hundred pounds became ' || v_airport::text);
    RETURN;
  END IF;

  v_breakdown := '{"airport_charge_pence": 320, "airportCharge": 7}'::jsonb;
  v_airport := 0;
  v_raw := NULLIF(v_breakdown->>'airport_charge_pence', '')::numeric;
  IF v_raw IS NULL OR v_raw <= 0 THEN
    v_airport := -1;
  ELSE
    v_airport := GREATEST(0, round(v_raw));
  END IF;
  IF v_airport <> 320 THEN
    INSERT INTO stamp_evidence VALUES ('json_fallback', false, 'pence field lost');
    RETURN;
  END IF;

  INSERT INTO stamp_evidence VALUES (
    'json_fallback',
    true,
    'quote major units and explicit pence; not a constant'
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO stamp_evidence VALUES ('json_fallback', false, SQLERRM);
END
$json$;

CREATE TEMP TABLE stamp_probe (LIKE public.ride_offers INCLUDING DEFAULTS);

CREATE TRIGGER stamp_probe_bi
  BEFORE INSERT ON stamp_probe
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_stamp_offer_presets_fn();

CREATE TEMP TABLE stamp_public_offer_before AS
SELECT count(*)::int AS n
FROM public.ride_offers
WHERE trip_id IN (
  '90095700-f4ac-4180-ad71-47102fce2471'::uuid,
  '4cd1b791-3c53-4062-b2d6-eaa776897481'::uuid
);

DO $probes$
DECLARE
  v_row stamp_probe%ROWTYPE;
  v_rate numeric;
  v_rate2 numeric;
  v_base integer;
  v_airport integer;
  v_commissionable integer;
  v_expected integer;
  v_preset_gross integer := 7800;
  v_preset_net integer;
  v_item jsonb;
  v_found boolean := false;
  v_expires timestamptz := '2026-09-13 11:16:27.940576+00';
BEGIN
  SELECT effective_percent INTO v_rate
  FROM public.resolve_wave_commission_percent(1, 0);
  SELECT effective_percent INTO v_rate2
  FROM public.resolve_wave_commission_percent(2, 0);

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '4cd1b791-3c53-4062-b2d6-eaa776897481',
    gen_random_uuid(),
    v_expires,
    'pending',
    false,
    1
  )
  RETURNING * INTO v_row;

  v_base := COALESCE((v_row.offer_snapshot->>'baseFarePence')::int, 0);
  v_expected := GREATEST(0, v_base - ROUND((v_base::numeric * COALESCE(v_row.effective_commission_percent, 0)) / 100.0));
  INSERT INTO stamp_evidence VALUES (
    'airport_zero_unchanged',
    v_row.expires_at = v_expires
      AND COALESCE(v_row.offer_snapshot->>'airport_charge_pence', '') = ''
      AND v_row.offered_driver_net_pence = v_expected
      AND v_row.effective_commission_percent = v_rate,
    'base=' || v_base::text
      || ' net=' || COALESCE(v_row.offered_driver_net_pence::text, 'null')
      || ' expected=' || v_expected::text
      || ' rate=' || COALESCE(v_row.effective_commission_percent::text, 'null')
  );

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '4cd1b791-3c53-4062-b2d6-eaa776897481',
    gen_random_uuid(),
    v_expires,
    'pending',
    false,
    2
  )
  RETURNING * INTO v_row;
  INSERT INTO stamp_evidence VALUES (
    'wave_rate_dynamic',
    v_row.effective_commission_percent = v_rate2
      AND v_row.effective_commission_percent IS DISTINCT FROM v_rate
      AND v_row.dispatch_wave = 2,
    'wave1=' || COALESCE(v_rate::text, 'null')
      || ' wave2=' || COALESCE(v_row.effective_commission_percent::text, 'null')
  );

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '90095700-f4ac-4180-ad71-47102fce2471',
    gen_random_uuid(),
    v_expires,
    'pending',
    true,
    1
  )
  RETURNING * INTO v_row;
  INSERT INTO stamp_evidence VALUES (
    'stacked_unchanged',
    v_row.offered_driver_net_pence IS NULL
      AND v_row.expires_at = v_expires
      AND COALESCE(v_row.offer_snapshot->>'airport_charge_pence', '') = '',
    'stacked returned before stamp'
  );

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '90095700-f4ac-4180-ad71-47102fce2471',
    gen_random_uuid(),
    v_expires,
    'revoked',
    false,
    1
  )
  RETURNING * INTO v_row;
  INSERT INTO stamp_evidence VALUES (
    'revoked_not_revived',
    v_row.status = 'revoked'
      AND v_row.offered_driver_net_pence IS NULL
      AND v_row.expires_at = v_expires,
    'revoked returned unchanged'
  );

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '90095700-f4ac-4180-ad71-47102fce2471',
    gen_random_uuid(),
    v_expires,
    'accepted',
    false,
    1
  )
  RETURNING * INTO v_row;
  INSERT INTO stamp_evidence VALUES (
    'accepted_not_revived',
    v_row.status = 'accepted' AND v_row.offered_driver_net_pence IS NULL,
    'accepted returned unchanged'
  );

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '90095700-f4ac-4180-ad71-47102fce2471',
    gen_random_uuid(),
    v_expires,
    'expired',
    false,
    1
  )
  RETURNING * INTO v_row;
  INSERT INTO stamp_evidence VALUES (
    'expired_not_revived',
    v_row.status = 'expired' AND v_row.offered_driver_net_pence IS NULL,
    'expired returned unchanged'
  );

  SELECT t.airport_charge_pence INTO v_airport
  FROM public.trips t
  WHERE t.id = '90095700-f4ac-4180-ad71-47102fce2471';

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '90095700-f4ac-4180-ad71-47102fce2471',
    gen_random_uuid(),
    v_expires,
    'pending',
    false,
    1
  )
  RETURNING * INTO v_row;

  v_base := COALESCE((v_row.offer_snapshot->>'baseFarePence')::int, 0);
  v_commissionable := GREATEST(0, v_base - COALESCE(v_airport, 0));
  v_expected := GREATEST(0, v_commissionable - ROUND((v_commissionable::numeric * COALESCE(v_rate, 0)) / 100.0))
    + COALESCE(v_airport, 0);
  INSERT INTO stamp_evidence VALUES (
    'mk_column_split',
    v_row.expires_at = v_expires
      AND (v_row.offer_snapshot->>'airport_charge_pence')::int = v_airport
      AND v_row.offered_driver_net_pence = v_expected
      AND v_row.effective_commission_percent = v_rate
      AND v_airport = (SELECT airport_charge_pence FROM public.trips WHERE id = '90095700-f4ac-4180-ad71-47102fce2471'),
    'airport=' || COALESCE(v_airport::text, 'null')
      || ' base=' || v_base::text
      || ' commissionable=' || v_commissionable::text
      || ' rate=' || COALESCE(v_rate::text, 'null')
      || ' net=' || COALESCE(v_row.offered_driver_net_pence::text, 'null')
      || ' expected=' || v_expected::text
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO stamp_evidence VALUES ('probe_exception', false, SQLERRM);
END
$probes$;

CREATE OR REPLACE FUNCTION public.compute_ride_offer_preset_options(p_trip public.trips)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $stub$
  SELECT jsonb_build_object(
    'ok', true,
    'base_pence', 7700,
    'preset_options', jsonb_build_array(
      jsonb_build_object('key', 'a', 'grossFarePence', 7800),
      jsonb_build_object('key', 'b', 'grossFarePence', 7850),
      jsonb_build_object('key', 'c', 'grossFarePence', 7900)
    ),
    'offer_options', jsonb_build_array(
      jsonb_build_object('id', 'a'),
      jsonb_build_object('id', 'b'),
      jsonb_build_object('id', 'c')
    )
  );
$stub$;

DO $preset$
DECLARE
  v_row stamp_probe%ROWTYPE;
  v_rate numeric;
  v_airport integer;
  v_other integer;
  v_gross integer := 7800;
  v_commissionable integer;
  v_expected integer;
  v_item jsonb;
  v_found boolean := false;
  v_expires timestamptz := '2026-09-13 11:16:27.940576+00';
BEGIN
  SELECT effective_percent INTO v_rate
  FROM public.resolve_wave_commission_percent(1, 0);
  SELECT airport_charge_pence, COALESCE(other_pass_through_charges_pence, 0)
    INTO v_airport, v_other
  FROM public.trips
  WHERE id = '90095700-f4ac-4180-ad71-47102fce2471';

  INSERT INTO stamp_probe (id, trip_id, driver_id, expires_at, status, is_stacked, dispatch_wave)
  VALUES (
    gen_random_uuid(),
    '90095700-f4ac-4180-ad71-47102fce2471',
    gen_random_uuid(),
    v_expires,
    'pending',
    false,
    1
  )
  RETURNING * INTO v_row;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(v_row.offer_snapshot->'preset_options', '[]'::jsonb))
  LOOP
    IF COALESCE((v_item->>'grossFarePence')::int, 0) = v_gross THEN
      v_found := true;
      EXIT;
    END IF;
  END LOOP;

  v_commissionable := GREATEST(0, v_gross - COALESCE(v_airport, 0) - COALESCE(v_other, 0));
  v_expected := GREATEST(0, v_commissionable - ROUND((v_commissionable::numeric * COALESCE(v_rate, 0)) / 100.0))
    + COALESCE(v_airport, 0) + COALESCE(v_other, 0);

  INSERT INTO stamp_evidence VALUES (
    'preset_7800_net',
    v_found
      AND COALESCE((v_item->>'driverNetPence')::int, -1) = v_expected
      AND v_row.offered_driver_net_pence IS NOT NULL
      AND v_row.expires_at = v_expires,
    'airport=' || COALESCE(v_airport::text, 'null')
      || ' rate=' || COALESCE(v_rate::text, 'null')
      || ' preset_net=' || COALESCE(v_item->>'driverNetPence', 'null')
      || ' expected=' || v_expected::text
      || ' offered_net=' || COALESCE(v_row.offered_driver_net_pence::text, 'null')
  );
EXCEPTION WHEN OTHERS THEN
  INSERT INTO stamp_evidence VALUES ('preset_7800_net', false, SQLERRM);
END
$preset$;

INSERT INTO stamp_evidence (case_name, ok, detail)
SELECT 'no_public_offer_insert',
       (SELECT count(*)::int FROM public.ride_offers
         WHERE trip_id IN (
           '90095700-f4ac-4180-ad71-47102fce2471'::uuid,
           '4cd1b791-3c53-4062-b2d6-eaa776897481'::uuid
         )) = (SELECT n FROM stamp_public_offer_before),
       'public ride_offers count unchanged during probes';

SELECT case_name, ok, detail
FROM stamp_evidence
ORDER BY case_name;

-- Always undo the replacement and the preset stub. No COMMIT in this file.
ROLLBACK;
