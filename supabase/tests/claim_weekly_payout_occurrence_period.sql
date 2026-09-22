-- Isolated PostgreSQL tests for weekly occurrence period freeze.
-- Does not touch public payout/wallet/provider tables.
-- Run: psql -h 127.0.0.1 -p 5432 -d postgres -U admin -v ON_ERROR_STOP=1 -f this file

DROP SCHEMA IF EXISTS weekly_period_sim CASCADE;
CREATE SCHEMA weekly_period_sim;

CREATE TABLE weekly_period_sim.weekly_payout_occurrence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_occurrence_key text NOT NULL,
  status text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  batch_id uuid,
  money_path_executed boolean NOT NULL DEFAULT false,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  period_start timestamptz,
  period_end timestamptz
);

CREATE UNIQUE INDEX uq_weekly_period_sim_key_dry
  ON weekly_period_sim.weekly_payout_occurrence_runs (schedule_occurrence_key, dry_run);

CREATE OR REPLACE FUNCTION weekly_period_sim.weekly_payout_previous_completed_week(
  p_schedule_occurrence_key text
)
RETURNS TABLE (period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  v_local text;
  v_instant timestamptz;
  v_local_date date;
  v_this_monday date;
  v_prev_monday date;
BEGIN
  v_local := substring(trim(p_schedule_occurrence_key) from '^weekly-payout:[^:]+:(.+)$');
  IF v_local IS NULL OR length(v_local) < 10 THEN
    RETURN;
  END IF;
  BEGIN
    v_instant := v_local::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  v_local_date := (v_instant AT TIME ZONE 'Europe/London')::date;
  v_this_monday := v_local_date - ((EXTRACT(ISODOW FROM v_local_date)::integer) - 1);
  v_prev_monday := v_this_monday - 7;
  period_start := v_prev_monday::timestamp AT TIME ZONE 'Europe/London';
  period_end := v_this_monday::timestamp AT TIME ZONE 'Europe/London';
  RETURN NEXT;
END;
$fn$;

CREATE OR REPLACE FUNCTION weekly_period_sim.period_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $trg$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.period_start IS NOT NULL AND NEW.period_start IS DISTINCT FROM OLD.period_start THEN
      RAISE EXCEPTION 'weekly occurrence period_start is immutable';
    END IF;
    IF OLD.period_end IS NOT NULL AND NEW.period_end IS DISTINCT FROM OLD.period_end THEN
      RAISE EXCEPTION 'weekly occurrence period_end is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$trg$;

CREATE TRIGGER trg_weekly_period_sim_immutable
  BEFORE UPDATE ON weekly_period_sim.weekly_payout_occurrence_runs
  FOR EACH ROW
  EXECUTE FUNCTION weekly_period_sim.period_immutable();

CREATE OR REPLACE FUNCTION weekly_period_sim.claim_weekly_payout_occurrence(
  p_schedule_occurrence_key text,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $claim$
DECLARE
  v_run weekly_period_sim.weekly_payout_occurrence_runs%ROWTYPE;
  v_new_id uuid;
  v_dry boolean := coalesce(p_dry_run, false);
  v_ps timestamptz;
  v_pe timestamptz;
BEGIN
  IF p_schedule_occurrence_key IS NULL OR length(trim(p_schedule_occurrence_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_occurrence_key');
  END IF;

  SELECT p.period_start, p.period_end INTO v_ps, v_pe
  FROM weekly_period_sim.weekly_payout_previous_completed_week(trim(p_schedule_occurrence_key)) p;

  INSERT INTO weekly_period_sim.weekly_payout_occurrence_runs (
    schedule_occurrence_key, status, dry_run, started_at, period_start, period_end
  )
  VALUES (trim(p_schedule_occurrence_key), 'RUNNING', v_dry, now(), v_ps, v_pe)
  ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'run_id', v_new_id, 'status', 'RUNNING',
      'dry_run', v_dry, 'money_path_executed', false, 'reused', false,
      'period_start', v_ps, 'period_end', v_pe
    );
  END IF;

  SELECT * INTO v_run
  FROM weekly_period_sim.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = trim(p_schedule_occurrence_key)
    AND dry_run = v_dry;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'claim_race_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'run_id', v_run.id, 'status', v_run.status,
    'dry_run', v_run.dry_run, 'money_path_executed', v_run.money_path_executed,
    'batch_id', v_run.batch_id, 'result_json', v_run.result_json, 'reused', true,
    'period_start', v_run.period_start, 'period_end', v_run.period_end
  );
END;
$claim$;

DO $$
DECLARE
  v1 jsonb;
  v2 jsonb;
  v_dry jsonb;
  v_expect_start timestamptz := timestamptz '2026-09-14 00:00:00 Europe/London';
  v_expect_end timestamptz := timestamptz '2026-09-21 00:00:00 Europe/London';
  n int;
BEGIN
  v1 := weekly_period_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', false
  );
  IF v1->>'ok' <> 'true' OR (v1->>'reused')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PERIOD1_FAIL first claim %', v1;
  END IF;
  IF (v1->>'period_start')::timestamptz IS DISTINCT FROM v_expect_start
     OR (v1->>'period_end')::timestamptz IS DISTINCT FROM v_expect_end THEN
    RAISE EXCEPTION 'PERIOD1_FAIL bounds %', v1;
  END IF;

  -- Delayed retry must reuse the same frozen period (not now()).
  PERFORM set_config('TimeZone', 'UTC', true);
  v2 := weekly_period_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', false
  );
  IF v2->>'reused' <> 'true' THEN
    RAISE EXCEPTION 'PERIOD2_FAIL reuse %', v2;
  END IF;
  IF (v2->>'period_start')::timestamptz IS DISTINCT FROM v_expect_start
     OR (v2->>'period_end')::timestamptz IS DISTINCT FROM v_expect_end THEN
    RAISE EXCEPTION 'PERIOD2_FAIL retry bounds %', v2;
  END IF;
  IF (v2->>'run_id') IS DISTINCT FROM (v1->>'run_id') THEN
    RAISE EXCEPTION 'PERIOD2_FAIL new occurrence %', v2;
  END IF;

  v_dry := weekly_period_sim.claim_weekly_payout_occurrence(
    'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00', true
  );
  IF v_dry->>'ok' <> 'true' OR (v_dry->>'reused')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PERIOD5_FAIL dry %', v_dry;
  END IF;
  IF (v_dry->>'period_start')::timestamptz IS DISTINCT FROM v_expect_start THEN
    RAISE EXCEPTION 'PERIOD5_FAIL dry period %', v_dry;
  END IF;
  SELECT count(*) INTO n FROM weekly_period_sim.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = 'weekly-payout:milton-keynes:2026-09-22T12:00:00+01:00';
  IF n <> 2 THEN RAISE EXCEPTION 'PERIOD5_FAIL coexist n=%', n; END IF;

  BEGIN
    UPDATE weekly_period_sim.weekly_payout_occurrence_runs
      SET period_end = timestamptz '2026-09-28 00:00:00 Europe/London'
      WHERE id = (v1->>'run_id')::uuid;
    RAISE EXCEPTION 'PERIOD_IMMUTABLE_FAIL update allowed';
  EXCEPTION WHEN others THEN
    IF SQLERRM NOT LIKE '%immutable%' THEN
      RAISE;
    END IF;
  END;

  RAISE NOTICE 'weekly_period_sim tests PASS';
END $$;
