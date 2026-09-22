-- Rollback weekly occurrence period columns + claim period freeze.
-- Restores 20261124150000 claim body (composite ON CONFLICT, no period stamp).
-- Does not drop uq_weekly_payout_occurrence_runs_key_dry.
-- Does not mutate payout/wallet/provider state.

BEGIN;

DROP TRIGGER IF EXISTS trg_weekly_payout_occurrence_period_immutable
  ON public.weekly_payout_occurrence_runs;
DROP FUNCTION IF EXISTS public.weekly_payout_occurrence_period_immutable();
DROP FUNCTION IF EXISTS public.weekly_payout_previous_completed_week(text);

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
  v_dry boolean := coalesce(p_dry_run, false);
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
    v_dry,
    now()
  )
  ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'run_id', v_new_id,
      'status', 'RUNNING',
      'dry_run', v_dry,
      'money_path_executed', false,
      'reused', false
    );
  END IF;

  SELECT * INTO v_run
  FROM public.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = trim(p_schedule_occurrence_key)
    AND dry_run = v_dry;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'claim_race_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', v_run.id,
    'status', v_run.status,
    'dry_run', v_run.dry_run,
    'money_path_executed', v_run.money_path_executed,
    'batch_id', v_run.batch_id,
    'result_json', v_run.result_json,
    'reused', true
  );
END;
$claim$;

ALTER TABLE public.weekly_payout_occurrence_runs
  DROP COLUMN IF EXISTS period_start,
  DROP COLUMN IF EXISTS period_end;

REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) TO service_role;

COMMIT;
