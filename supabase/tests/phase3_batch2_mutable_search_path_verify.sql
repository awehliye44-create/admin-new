-- Phase 3 Batch 2 — transaction-only mutable search_path verification.
-- ALWAYS ends in ROLLBACK. Does not persist rows.
-- Apply ALTERs under test inside the same transaction (or after live apply for post-check).

BEGIN;

CREATE TEMP TABLE _b2_snap ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.payout_items) AS payout_items_n,
  (SELECT count(*) FROM public.payout_batches) AS payout_batches_n,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS ledger_n,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS ledger_sum,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions_n,
  (SELECT coalesce(sum(wallet_balance), 0) FROM public.driver_financial_summary) AS wallet_balance_sum,
  (SELECT count(*) FROM cron.job) AS cron_n,
  (SELECT count(*) FROM public.campaign_heads_up_templates) AS templates_n,
  (SELECT count(*) FROM public.campaign_heads_up_campaigns) AS campaigns_n;

-- Before results (representative inputs)
CREATE TEMP TABLE _b2_before ON COMMIT DROP AS
SELECT
  public.payout_ledger_type_is_payout_eligible('TRIP_EARNING_NET') AS elig_ten,
  public.payout_ledger_type_is_payout_eligible('ADMIN_CREDIT') AS elig_admin,
  public.payout_ledger_type_is_payout_eligible(NULL) AS elig_null,
  public.driver_wallet_captured_at_restamp_suspect(
    timestamptz '2026-08-20 12:00:00+00',
    timestamptz '2026-08-18 10:00:00+00',
    timestamptz '2026-08-18 11:00:00+00'
  ) AS restamp_true,
  public.driver_wallet_captured_at_restamp_suspect(
    timestamptz '2026-08-18 12:00:00+00',
    timestamptz '2026-08-18 10:00:00+00',
    timestamptz '2026-08-18 11:00:00+00'
  ) AS restamp_false,
  public.driver_wallet_stable_clearing_origin(
    timestamptz '2026-08-20 12:00:00+00',
    timestamptz '2026-08-18 10:00:00+00',
    timestamptz '2026-08-18 12:30:00+00',
    timestamptz '2026-08-18 11:00:00+00',
    NULL
  ) AS origin_restamp,
  public.driver_wallet_stable_clearing_origin(
    timestamptz '2026-08-18 12:00:00+00',
    timestamptz '2026-08-18 10:00:00+00',
    NULL,
    timestamptz '2026-08-18 11:00:00+00',
    timestamptz '2026-08-18 11:45:00+00'
  ) AS origin_first;

-- Apply Batch 2 (no COMMIT of outer txn)
ALTER FUNCTION public.payout_ledger_type_is_payout_eligible(text)
  SET search_path TO pg_catalog;
ALTER FUNCTION public.scrub_campaign_heads_up_taxi_branding()
  SET search_path TO pg_catalog;
ALTER FUNCTION public.driver_wallet_captured_at_restamp_suspect(
  timestamp with time zone, timestamp with time zone, timestamp with time zone
) SET search_path TO pg_catalog;
ALTER FUNCTION public.driver_wallet_stable_clearing_origin(
  timestamp with time zone, timestamp with time zone, timestamp with time zone,
  timestamp with time zone, timestamp with time zone
) SET search_path TO pg_catalog;

-- After results must match before
DO $$
DECLARE
  b record;
  a record;
  mutable_left int;
BEGIN
  SELECT * INTO b FROM _b2_before;
  SELECT
    public.payout_ledger_type_is_payout_eligible('TRIP_EARNING_NET') AS elig_ten,
    public.payout_ledger_type_is_payout_eligible('ADMIN_CREDIT') AS elig_admin,
    public.payout_ledger_type_is_payout_eligible(NULL) AS elig_null,
    public.driver_wallet_captured_at_restamp_suspect(
      timestamptz '2026-08-20 12:00:00+00',
      timestamptz '2026-08-18 10:00:00+00',
      timestamptz '2026-08-18 11:00:00+00'
    ) AS restamp_true,
    public.driver_wallet_captured_at_restamp_suspect(
      timestamptz '2026-08-18 12:00:00+00',
      timestamptz '2026-08-18 10:00:00+00',
      timestamptz '2026-08-18 11:00:00+00'
    ) AS restamp_false,
    public.driver_wallet_stable_clearing_origin(
      timestamptz '2026-08-20 12:00:00+00',
      timestamptz '2026-08-18 10:00:00+00',
      timestamptz '2026-08-18 12:30:00+00',
      timestamptz '2026-08-18 11:00:00+00',
      NULL
    ) AS origin_restamp,
    public.driver_wallet_stable_clearing_origin(
      timestamptz '2026-08-18 12:00:00+00',
      timestamptz '2026-08-18 10:00:00+00',
      NULL,
      timestamptz '2026-08-18 11:00:00+00',
      timestamptz '2026-08-18 11:45:00+00'
    ) AS origin_first
  INTO a;

  IF b IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'BATCH2_RESULT_MISMATCH before=% after=%', b, a;
  END IF;

  SELECT count(*)::int INTO mutable_left
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY (ARRAY[
      'payout_ledger_type_is_payout_eligible',
      'scrub_campaign_heads_up_taxi_branding',
      'driver_wallet_captured_at_restamp_suspect',
      'driver_wallet_stable_clearing_origin'
    ])
    AND (
      p.proconfig IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) cfg
        WHERE cfg LIKE 'search_path=%'
      )
    );

  IF mutable_left <> 0 THEN
    RAISE EXCEPTION 'BATCH2_MUTABLE_REMAINING %', mutable_left;
  END IF;
END $$;

-- Trigger behaviour inside SAVEPOINT so row counts stay unchanged for integrity check
SAVEPOINT batch2_trigger_probe;
DO $$
DECLARE
  v_title text;
  v_emoji text;
BEGIN
  INSERT INTO public.campaign_heads_up_templates (
    slug, category, name, title, subtitle, emoji
  ) VALUES (
    'batch2-probe-' || replace(gen_random_uuid()::text, '-', ''),
    'announcement',
    'Batch2 Probe',
    'Hello 🚖 world',
    'sub 🚖',
    '🚖'
  )
  RETURNING title, emoji INTO v_title, v_emoji;

  IF v_title IS DISTINCT FROM 'Hello ✨ world' THEN
    RAISE EXCEPTION 'BATCH2_TRIGGER_TITLE %', v_title;
  END IF;
  IF v_emoji IS DISTINCT FROM '✨' THEN
    RAISE EXCEPTION 'BATCH2_TRIGGER_EMOJI %', v_emoji;
  END IF;
END $$;
ROLLBACK TO SAVEPOINT batch2_trigger_probe;

DO $$
DECLARE
  s1 record;
  s2 record;
BEGIN
  SELECT * INTO s1 FROM _b2_snap;
  SELECT
    (SELECT count(*) FROM public.payout_items) AS payout_items_n,
    (SELECT count(*) FROM public.payout_batches) AS payout_batches_n,
    (SELECT count(*) FROM public.driver_wallet_ledger) AS ledger_n,
    (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS ledger_sum,
    (SELECT count(*) FROM public.payment_sessions) AS payment_sessions_n,
    (SELECT coalesce(sum(wallet_balance), 0) FROM public.driver_financial_summary) AS wallet_balance_sum,
    (SELECT count(*) FROM cron.job) AS cron_n,
    (SELECT count(*) FROM public.campaign_heads_up_templates) AS templates_n,
    (SELECT count(*) FROM public.campaign_heads_up_campaigns) AS campaigns_n
  INTO s2;
  IF s1 IS DISTINCT FROM s2 THEN
    RAISE EXCEPTION 'BATCH2_DATA_CHANGED % %', s1, s2;
  END IF;
END $$;

SELECT 'PHASE3_BATCH2_VERIFY_OK' AS status,
       (SELECT row_to_json(t) FROM _b2_before t) AS sample_results,
       (SELECT row_to_json(t) FROM _b2_snap t) AS counts;

ROLLBACK;
