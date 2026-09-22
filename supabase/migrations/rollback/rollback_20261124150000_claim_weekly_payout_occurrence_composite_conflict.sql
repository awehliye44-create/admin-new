-- Rollback: restore 20260832010000 claim body (single-column ON CONFLICT).
-- Does not drop uq_weekly_payout_occurrence_runs_key_dry (pre-existing live index).
-- Restoring this body without that index matching ON CONFLICT will fail claims again.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_weekly_payout_occurrence(
  p_schedule_occurrence_key text,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $claim$
DECLARE
  v_run public.weekly_payout_occurrence_runs%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF p_schedule_occurrence_key IS NULL OR length(trim(p_schedule_occurrence_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_occurrence_key');
  END IF;

  INSERT INTO public.weekly_payout_occurrence_runs (
    schedule_occurrence_key,
    status,
    dry_run,
    started_at
  )
  VALUES (
    trim(p_schedule_occurrence_key),
    'RUNNING',
    coalesce(p_dry_run, false),
    now()
  )
  ON CONFLICT (schedule_occurrence_key) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'run_id', v_new_id,
      'status', 'RUNNING',
      'money_path_executed', false,
      'reused', false
    );
  END IF;

  SELECT * INTO v_run
  FROM public.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = trim(p_schedule_occurrence_key);

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'claim_race_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', v_run.id,
    'status', v_run.status,
    'money_path_executed', v_run.money_path_executed,
    'batch_id', v_run.batch_id,
    'result_json', v_run.result_json,
    'reused', true
  );
END;
$claim$;

REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) TO service_role;

COMMIT;
