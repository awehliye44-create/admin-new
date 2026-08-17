-- Contract: a payout item cannot execute without immutable DWL allocations.
-- Run after 20260927180200. Always rolled back.

BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.assert_payout_item_ledger_lineage(uuid)'::regprocedure)
    INTO v_def;
  IF v_def IS NULL OR position('PAYOUT_LINEAGE_MISSING' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: assert_payout_item_ledger_lineage missing PAYOUT_LINEAGE_MISSING';
  END IF;
  IF position('PLATFORM_COLLECTED' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: lineage must require PLATFORM_COLLECTED trip-linked entries';
  END IF;
  IF position('DRIVER_COLLECTED_COMMISSION_WALLET' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: lineage must forbid Driver-Collected entries';
  END IF;
  SELECT pg_get_functiondef('public.payout_item_status_releases_ledger_allocation(text,text)'::regprocedure)
    INTO v_def;
  IF position('FAILED' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: failed payouts must release ledger for retry while keeping allocation rows';
  END IF;
  RAISE NOTICE 'payout lineage function presence PASS';
END $$;

DO $$
DECLARE
  v_driver uuid;
  v_batch uuid;
  v_item uuid;
  v_raised boolean := false;
  v_sqlstate text;
BEGIN
  SELECT id INTO v_driver FROM public.drivers LIMIT 1;
  IF v_driver IS NULL THEN
    RAISE NOTICE 'SKIP: no drivers available for lineage execute test';
    RETURN;
  END IF;

  INSERT INTO public.payout_batches (
    kind, run_date, status, total_drivers, total_amount_pence, currency
  ) VALUES (
    'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED', 1, 100, 'GBP'
  ) RETURNING id INTO v_batch;

  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, status, execution_status, currency
  ) VALUES (
    v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED', 'GBP'
  ) RETURNING id INTO v_item;

  BEGIN
    PERFORM public.assert_payout_item_ledger_lineage(v_item);
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
    GET STACKED DIAGNOSTICS v_sqlstate = MESSAGE_TEXT;
    IF position('PAYOUT_LINEAGE_MISSING' in v_sqlstate) = 0 THEN
      RAISE EXCEPTION 'TEST FAIL: expected PAYOUT_LINEAGE_MISSING, got %', v_sqlstate;
    END IF;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAIL: payout without allocations was accepted by assert';
  END IF;

  v_raised := false;
  BEGIN
    UPDATE public.payout_items
    SET status = 'SUBMITTING', execution_status = 'SUBMITTING'
    WHERE id = v_item;
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAIL: bank-transfer status without allocations was accepted';
  END IF;

  v_raised := false;
  BEGIN
    INSERT INTO public.payout_items (
      batch_id, driver_id, amount_pence, status, execution_status, currency
    ) VALUES (
      v_batch, v_driver, 100, 'SUBMITTING', 'SUBMITTING', 'GBP'
    );
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAIL: INSERT execute-status payout without allocations was accepted';
  END IF;

  RAISE NOTICE 'payout without allocations rejected PASS';
END $$;

DO $$
DECLARE
  v_driver uuid;
  v_batch uuid;
  v_item uuid;
  v_cash uuid;
  v_ten uuid;
  v_ten_driver uuid;
  v_ten_amount integer;
  v_raised boolean := false;
  v_item2 uuid;
BEGIN
  SELECT id INTO v_driver FROM public.drivers LIMIT 1;
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'TEST FAIL: no driver for lineage allocation tests';
  END IF;

  INSERT INTO public.driver_wallet_ledger (
    driver_id, type, amount_pence, description
  ) VALUES (
    v_driver,
    'PLATFORM_COMMISSION',
    100,
    'lineage test ineligible type — rolled back'
  ) RETURNING id INTO v_cash;

  INSERT INTO public.payout_batches (
    kind, run_date, status, total_drivers, total_amount_pence, currency
  ) VALUES (
    'WEEKLY_MONDAY', CURRENT_DATE + 400, 'ITEMS_CREATED', 1, 1, 'GBP'
  ) RETURNING id INTO v_batch;
  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, status, execution_status, currency
  ) VALUES (
    v_batch, v_driver, 1, 'VALIDATED', 'VALIDATED', 'GBP'
  ) RETURNING id INTO v_item;
  BEGIN
    INSERT INTO public.payout_item_ledger_allocations (
      payout_item_id, ledger_entry_id, amount_pence, allocated_at
    ) VALUES (
      v_item, v_cash, 1, now()
    );
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAIL: ineligible ledger type was allocated to a payout item';
  END IF;
  RAISE NOTICE 'ineligible ledger type allocation rejected PASS';

  -- Always seed a rolled-back earning. Do not skip when production has no
  -- PLATFORM_COLLECTED stamp yet (today's development trips are unstamped).
  v_ten_driver := v_driver;
  v_ten_amount := 100;
  INSERT INTO public.driver_wallet_ledger (
    driver_id, type, amount_pence, description
  ) VALUES (
    v_ten_driver,
    'TRIP_EARNING_NET',
    v_ten_amount,
    'lineage test synthetic earning — rolled back'
  ) RETURNING id INTO v_ten;

  INSERT INTO public.payout_batches (
    kind, run_date, status, total_drivers, total_amount_pence, currency
  ) VALUES (
    'WEEKLY_MONDAY', CURRENT_DATE + 401, 'ITEMS_CREATED', 1, v_ten_amount, 'GBP'
  ) RETURNING id INTO v_batch;
  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, status, execution_status, currency
  ) VALUES (
    v_batch, v_ten_driver, v_ten_amount, 'VALIDATED', 'VALIDATED', 'GBP'
  ) RETURNING id INTO v_item;
  INSERT INTO public.payout_item_ledger_allocations (
    payout_item_id, ledger_entry_id, amount_pence, allocated_at
  ) VALUES (
    v_item, v_ten, v_ten_amount, now()
  );

  v_raised := false;
  BEGIN
    DELETE FROM public.payout_item_ledger_allocations WHERE payout_item_id = v_item;
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAIL: allocation rows were deleted';
  END IF;

  INSERT INTO public.payout_batches (
    kind, run_date, status, total_drivers, total_amount_pence, currency
  ) VALUES (
    'WEEKLY_MONDAY', CURRENT_DATE + 402, 'ITEMS_CREATED', 1, v_ten_amount, 'GBP'
  ) RETURNING id INTO v_batch;
  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, status, execution_status, currency
  ) VALUES (
    v_batch, v_ten_driver, v_ten_amount, 'VALIDATED', 'VALIDATED', 'GBP'
  ) RETURNING id INTO v_item2;
  v_raised := false;
  BEGIN
    INSERT INTO public.payout_item_ledger_allocations (
      payout_item_id, ledger_entry_id, amount_pence, allocated_at
    ) VALUES (
      v_item2, v_ten, v_ten_amount, now()
    );
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'TEST FAIL: same earning was allocated to a second reserved/validated payout';
  END IF;

  UPDATE public.payout_items
  SET status = 'FAILED', execution_status = 'FAILED'
  WHERE id = v_item;

  INSERT INTO public.payout_item_ledger_allocations (
    payout_item_id, ledger_entry_id, amount_pence, allocated_at
  ) VALUES (
    v_item2, v_ten, v_ten_amount, now()
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.payout_item_ledger_allocations WHERE payout_item_id = v_item
  ) THEN
    RAISE EXCEPTION 'TEST FAIL: failed payout lost auditable allocation rows';
  END IF;

  RAISE NOTICE 'allocation immutability, no double-pay, failed retry PASS';

  -- Trip-linked Driver-Collected / unstamped rows cannot enter Payout Ledger.
  DECLARE
    v_dc_trip uuid;
    v_dc_driver uuid;
    v_dc_earn uuid;
    v_dc_item uuid;
    v_dc_batch uuid;
  BEGIN
    SELECT t.id, t.driver_id
      INTO v_dc_trip, v_dc_driver
    FROM public.trips t
    JOIN public.service_areas sa ON sa.id = t.service_area_id
    WHERE t.driver_id IS NOT NULL
      AND (
        t.financial_model IS DISTINCT FROM 'PLATFORM_COLLECTED'
        OR sa.name ILIKE '%banadir%'
      )
    LIMIT 1;
    IF v_dc_trip IS NULL THEN
      RAISE NOTICE 'SKIP: no non-PLATFORM trip for Driver-Collected allocation test';
    ELSE
      v_raised := false;
      BEGIN
        INSERT INTO public.driver_wallet_ledger (
          driver_id, related_trip_id, type, amount_pence, description
        ) VALUES (
          v_dc_driver, v_dc_trip, 'TRIP_EARNING_NET', 50,
          'lineage test Driver-Collected earning — rolled back'
        ) RETURNING id INTO v_dc_earn;
        INSERT INTO public.payout_batches (
          kind, run_date, status, total_drivers, total_amount_pence, currency
        ) VALUES (
          'WEEKLY_MONDAY', CURRENT_DATE + 403, 'ITEMS_CREATED', 1, 50, 'GBP'
        ) RETURNING id INTO v_dc_batch;
        INSERT INTO public.payout_items (
          batch_id, driver_id, amount_pence, status, execution_status, currency
        ) VALUES (
          v_dc_batch, v_dc_driver, 50, 'VALIDATED', 'VALIDATED', 'GBP'
        ) RETURNING id INTO v_dc_item;
        INSERT INTO public.payout_item_ledger_allocations (
          payout_item_id, ledger_entry_id, amount_pence, allocated_at
        ) VALUES (
          v_dc_item, v_dc_earn, 50, now()
        );
      EXCEPTION WHEN check_violation THEN
        v_raised := true;
      END;
      IF NOT v_raised THEN
        RAISE EXCEPTION 'TEST FAIL: Driver-Collected / unstamped trip earning was allocated';
      END IF;
      RAISE NOTICE 'Driver-Collected trip earning allocation rejected PASS';
    END IF;
  END;
END $$;

ROLLBACK;
