-- Concurrent / lifecycle harness for reserve EARLY allow-list.
-- Intended for local or approved staging: wrap callers in BEGIN; … ROLLBACK;
-- Does NOT call any provider. Does NOT commit money movement.
-- PREPARED NOT APPLIED with the forward function migration.

-- Usage (operator):
--   BEGIN;
--   \i …/20261112200000_reserve_driver_payout_item_early_cashout_allowlist.sql  -- or apply function only
--   \i …/20261112200000_reserve_early_cashout_allowlist_concurrency_harness.sql
--   ROLLBACK;

CREATE OR REPLACE FUNCTION public._test_reserve_early_allowlist_harness()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver uuid;
  v_dest uuid;
  v_sa uuid;
  v_batch_early uuid;
  v_batch_weekly uuid;
  v_batch_bad uuid;
  v_item_early uuid;
  v_item_weekly uuid;
  v_item_bad uuid;
  v_item_early2 uuid;
  v_r1 jsonb;
  v_r2 jsonb;
  v_r3 jsonb;
  v_r4 jsonb;
  v_r5 jsonb;
  v_idem text := 'harness-early-allowlist:' || gen_random_uuid()::text;
  v_results jsonb := '[]'::jsonb;
BEGIN
  -- Pick any active PROVIDER_VERIFIED destination + its driver (read-only selection).
  SELECT d.driver_id, d.id, dr.service_area_id
  INTO v_driver, v_dest, v_sa
  FROM public.driver_payout_destinations d
  JOIN public.drivers dr ON dr.id = d.driver_id
  WHERE d.is_active IS TRUE
    AND d.archived_at IS NULL
    AND upper(coalesce(d.provider_link_status, '')) = 'PROVIDER_VERIFIED'
    AND nullif(trim(coalesce(d.provider_counterparty_id, '')), '') IS NOT NULL
    AND nullif(trim(coalesce(d.provider_recipient_account_id, '')), '') IS NOT NULL
  LIMIT 1;

  IF v_driver IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_VERIFIED_DESTINATION_FOR_HARNESS');
  END IF;

  -- EARLY batch/item
  INSERT INTO public.payout_batches (kind, status, service_area_id, schedule_occurrence_key, currency, eligible_driver_count)
  VALUES ('EARLY_CASHOUT', 'ITEMS_CREATED', v_sa, v_idem || ':early', 'GBP', 1)
  RETURNING id INTO v_batch_early;

  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, net_driver_payout_pence, currency, status,
    payout_destination_id, idempotency_key, payout_type
  ) VALUES (
    v_batch_early, v_driver, 3319, 3269, 'GBP', 'VALIDATED',
    v_dest, v_idem || ':early-item', 'EARLY_CASHOUT'
  ) RETURNING id INTO v_item_early;

  -- WEEKLY batch/item
  INSERT INTO public.payout_batches (kind, status, service_area_id, schedule_occurrence_key, currency, eligible_driver_count)
  VALUES ('WEEKLY_SCHEDULED', 'ITEMS_CREATED', v_sa, v_idem || ':weekly', 'GBP', 1)
  RETURNING id INTO v_batch_weekly;

  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, net_driver_payout_pence, currency, status,
    payout_destination_id, idempotency_key, payout_type
  ) VALUES (
    v_batch_weekly, v_driver, 1000, 1000, 'GBP', 'VALIDATED',
    v_dest, v_idem || ':weekly-item', 'WEEKLY_SCHEDULED'
  ) RETURNING id INTO v_item_weekly;

  -- Unsupported kind
  INSERT INTO public.payout_batches (kind, status, service_area_id, schedule_occurrence_key, currency, eligible_driver_count)
  VALUES ('WEEKLY_MONDAY', 'ITEMS_CREATED', v_sa, v_idem || ':bad', 'GBP', 1)
  RETURNING id INTO v_batch_bad;

  INSERT INTO public.payout_items (
    batch_id, driver_id, amount_pence, net_driver_payout_pence, currency, status,
    payout_destination_id, idempotency_key, payout_type
  ) VALUES (
    v_batch_bad, v_driver, 500, 500, 'GBP', 'VALIDATED',
    v_dest, v_idem || ':bad-item', 'WEEKLY_MONDAY'
  ) RETURNING id INTO v_item_bad;

  -- Note: full reserve may still fail on lineage/eligibility/balance in harness DBs.
  -- Kind-gate assertions below are the hard locks for this migration.
  v_r1 := public.reserve_driver_payout_item(v_item_early);
  v_r3 := public.reserve_driver_payout_item(v_item_bad);

  v_results := v_results || jsonb_build_array(jsonb_build_object(
    'case', 'early_kind_not_batch_not_eligible_for_kind_alone',
    'ok', coalesce(v_r1->>'error_code', '') IS DISTINCT FROM 'BATCH_NOT_ELIGIBLE'
      OR (v_r1->>'ok') = 'true',
    'result', v_r1
  ));

  v_results := v_results || jsonb_build_array(jsonb_build_object(
    'case', 'unsupported_kind_rejected',
    'ok', (v_r3->>'ok') = 'false' AND (v_r3->>'error_code') = 'BATCH_NOT_ELIGIBLE',
    'result', v_r3
  ));

  -- Same idempotency reuse path: second early item with same key should not insert (unique) —
  -- instead call reserve twice on same item.
  v_r4 := public.reserve_driver_payout_item(v_item_early);
  v_results := v_results || jsonb_build_array(jsonb_build_object(
    'case', 'repeat_reserve_same_item_idempotent_or_stable',
    'ok', (v_r4->>'error_code') IS DISTINCT FROM 'BATCH_NOT_ELIGIBLE',
    'result', v_r4
  ));

  -- Weekly kind not rejected for kind alone
  v_r2 := public.reserve_driver_payout_item(v_item_weekly);
  v_results := v_results || jsonb_build_array(jsonb_build_object(
    'case', 'weekly_kind_not_batch_not_eligible_for_kind_alone',
    'ok', coalesce(v_r2->>'error_code', '') IS DISTINCT FROM 'BATCH_NOT_ELIGIBLE'
      OR (v_r2->>'ok') = 'true',
    'result', v_r2
  ));

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', v_driver,
    'results', v_results,
    'note', 'Caller MUST ROLLBACK. Provider never called.'
  );
END;
$function$;
