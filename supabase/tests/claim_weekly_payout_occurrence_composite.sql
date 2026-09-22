-- Isolated PostgreSQL tests for claim_weekly_payout_occurrence composite identity.
-- Does not touch public payout/wallet/provider tables.
-- Run: psql -h 127.0.0.1 -p 5432 -d postgres -U admin -v ON_ERROR_STOP=1 -f this file

DROP SCHEMA IF EXISTS weekly_claim_sim CASCADE;
CREATE SCHEMA weekly_claim_sim;

CREATE TABLE weekly_claim_sim.weekly_payout_occurrence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_occurrence_key text NOT NULL,
  status text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  batch_id uuid,
  money_path_executed boolean NOT NULL DEFAULT false,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz
);

CREATE UNIQUE INDEX uq_weekly_claim_sim_key_dry
  ON weekly_claim_sim.weekly_payout_occurrence_runs (schedule_occurrence_key, dry_run);

CREATE OR REPLACE FUNCTION weekly_claim_sim.claim_weekly_payout_occurrence(
  p_schedule_occurrence_key text,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $claim$
DECLARE
  v_run weekly_claim_sim.weekly_payout_occurrence_runs%ROWTYPE;
  v_new_id uuid;
  v_dry boolean := coalesce(p_dry_run, false);
BEGIN
  IF p_schedule_occurrence_key IS NULL OR length(trim(p_schedule_occurrence_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_occurrence_key');
  END IF;

  INSERT INTO weekly_claim_sim.weekly_payout_occurrence_runs (
    schedule_occurrence_key, status, dry_run, started_at
  )
  VALUES (trim(p_schedule_occurrence_key), 'RUNNING', v_dry, now())
  ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'run_id', v_new_id, 'status', 'RUNNING',
      'dry_run', v_dry, 'money_path_executed', false, 'reused', false
    );
  END IF;

  SELECT * INTO v_run
  FROM weekly_claim_sim.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = trim(p_schedule_occurrence_key)
    AND dry_run = v_dry;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'claim_race_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'run_id', v_run.id, 'status', v_run.status,
    'dry_run', v_run.dry_run, 'money_path_executed', v_run.money_path_executed,
    'batch_id', v_run.batch_id, 'result_json', v_run.result_json, 'reused', true
  );
END;
$claim$;

DO $$
DECLARE
  v1 jsonb;
  v2 jsonb;
  v_dry jsonb;
  v_other jsonb;
  v_id uuid;
  n int;
BEGIN
  -- 1. First live claim creates exactly one row.
  v1 := weekly_claim_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', false
  );
  IF v1->>'ok' <> 'true' OR (v1->>'reused')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'TEST1_FAIL first live claim %', v1;
  END IF;
  v_id := (v1->>'run_id')::uuid;
  SELECT count(*) INTO n FROM weekly_claim_sim.weekly_payout_occurrence_runs
  WHERE dry_run = false;
  IF n <> 1 THEN RAISE EXCEPTION 'TEST1_FAIL rowcount=%', n; END IF;

  -- 2. Repeated live claim reuses the same occurrence.
  v2 := weekly_claim_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', false
  );
  IF v2->>'reused' <> 'true' OR (v2->>'run_id')::uuid IS DISTINCT FROM v_id THEN
    RAISE EXCEPTION 'TEST2_FAIL reuse %', v2;
  END IF;
  SELECT count(*) INTO n FROM weekly_claim_sim.weekly_payout_occurrence_runs
  WHERE dry_run = false;
  IF n <> 1 THEN RAISE EXCEPTION 'TEST2_FAIL duplicate live row'; END IF;

  -- 4. Dry-run and live can coexist for the same key.
  v_dry := weekly_claim_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', true
  );
  IF v_dry->>'ok' <> 'true' OR (v_dry->>'reused')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'TEST4_FAIL dry %', v_dry;
  END IF;
  IF (v_dry->>'run_id')::uuid = v_id THEN
    RAISE EXCEPTION 'TEST4_FAIL dry reused live id';
  END IF;
  SELECT count(*) INTO n FROM weekly_claim_sim.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = 'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00';
  IF n <> 2 THEN RAISE EXCEPTION 'TEST4_FAIL coexist n=%', n; END IF;

  -- 5. Repeated dry-run is idempotent.
  v2 := weekly_claim_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', true
  );
  IF v2->>'reused' <> 'true' OR (v2->>'run_id') IS DISTINCT FROM (v_dry->>'run_id') THEN
    RAISE EXCEPTION 'TEST5_FAIL dry reuse %', v2;
  END IF;

  -- 6. A different scheduled key creates a different occurrence.
  v_other := weekly_claim_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-29T12:00:00+01:00', false
  );
  IF v_other->>'reused' <> 'false' OR (v_other->>'run_id')::uuid = v_id THEN
    RAISE EXCEPTION 'TEST6_FAIL other key %', v_other;
  END IF;

  -- 7. Thirteen historical (key, dry_run) pairs remain uniquely insertable.
  DELETE FROM weekly_claim_sim.weekly_payout_occurrence_runs;
  INSERT INTO weekly_claim_sim.weekly_payout_occurrence_runs
    (schedule_occurrence_key, status, dry_run)
  VALUES
    ('weekly-payout:milton-keynes:2026-09-01T12:00:00+01:00', 'COMPLETED', false),
    ('weekly-payout:milton-keynes:2026-09-01T12:00:00+01:00', 'BLOCKED', true),
    ('weekly-payout:milton-keynes:2026-08-25T12:00:00+01:00', 'COMPLETED', false),
    ('weekly-payout:milton-keynes:2026-08-11T12:00:00+01:00', 'COMPLETED', false),
    ('weekly-payout:milton-keynes:2026-08-04T12:00:00+01:00', 'BLOCKED', false),
    ('weekly-payout:milton-keynes:2026-07-28T12:00:00+01:00', 'BLOCKED', false),
    ('weekly-payout:milton-keynes:2026-07-21T12:00:00+01:00', 'COMPLETED', false),
    ('weekly-payout:milton-keynes:2026-07-21T12:00:00+01:00', 'BLOCKED', true),
    ('weekly-payout:milton-keynes:2026-07-18T22:55:00+01:00', 'COMPLETED', false),
    ('weekly-payout:milton-keynes:2026-07-18T21:40:00+01:00', 'BLOCKED', false),
    ('weekly-payout:milton-keynes:gate2-preflight-2026-07-18T21:30:00+01:00', 'BLOCKED', true),
    ('rls-verify:service-role:20260718194834847', 'COMPLETED', true),
    ('rls-verify:test-occurrence:20260718194745', 'COMPLETED', true);
  SELECT count(*) INTO n FROM weekly_claim_sim.weekly_payout_occurrence_runs;
  IF n <> 13 THEN RAISE EXCEPTION 'TEST7_FAIL historical n=%', n; END IF;

  -- 8. Claim function cannot create batch/item/reservation/provider state
  --     (schema has only occurrence rows).
  IF to_regclass('weekly_claim_sim.payout_batches') IS NOT NULL
     OR to_regclass('weekly_claim_sim.payout_items') IS NOT NULL
     OR to_regclass('weekly_claim_sim.driver_payout_reservations') IS NOT NULL THEN
    RAISE EXCEPTION 'TEST8_FAIL unexpected money tables';
  END IF;

  -- 10. Reuse of a completed money-path row keeps a single row.
  UPDATE weekly_claim_sim.weekly_payout_occurrence_runs
    SET status = 'COMPLETED', money_path_executed = true
    WHERE schedule_occurrence_key = 'weekly-payout:milton-keynes:2026-08-25T12:00:00+01:00'
      AND dry_run = false;
  v2 := weekly_claim_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-08-25T12:00:00+01:00', false
  );
  IF v2->>'reused' <> 'true' OR (v2->>'money_path_executed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'TEST10_FAIL completed reuse %', v2;
  END IF;
  SELECT count(*) INTO n FROM weekly_claim_sim.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = 'weekly-payout:milton-keynes:2026-08-25T12:00:00+01:00'
    AND dry_run = false;
  IF n <> 1 THEN RAISE EXCEPTION 'TEST10_FAIL second payout row'; END IF;

  RAISE NOTICE 'weekly_claim_sim serial tests PASS';
END $$;
