-- Isolate dry-run occurrence claims from production money-path claims.
-- Allows one dry_run=true and one dry_run=false row per schedule_occurrence_key.

BEGIN;

DROP INDEX IF EXISTS public.uq_weekly_payout_occurrence_runs_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_payout_occurrence_runs_key_dry
  ON public.weekly_payout_occurrence_runs (schedule_occurrence_key, dry_run);

CREATE OR REPLACE FUNCTION public.claim_weekly_payout_occurrence(
  p_schedule_occurrence_key TEXT,
  p_dry_run BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.weekly_payout_occurrence_runs%ROWTYPE;
  v_inserted BOOLEAN := false;
  v_dry BOOLEAN := coalesce(p_dry_run, false);
BEGIN
  IF p_schedule_occurrence_key IS NULL OR length(trim(p_schedule_occurrence_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_occurrence_key');
  END IF;

  INSERT INTO public.weekly_payout_occurrence_runs (
    schedule_occurrence_key, status, dry_run, claimed_at
  ) VALUES (
    trim(p_schedule_occurrence_key), 'CLAIMED', v_dry, now()
  )
  ON CONFLICT (schedule_occurrence_key, dry_run) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    v_inserted := true;
  ELSE
    SELECT * INTO v_row
    FROM public.weekly_payout_occurrence_runs
    WHERE schedule_occurrence_key = trim(p_schedule_occurrence_key)
      AND dry_run = v_dry;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'claimed_new', v_inserted,
    'run_id', v_row.id,
    'status', v_row.status,
    'batch_id', v_row.batch_id,
    'blocker_code', v_row.blocker_code,
    'dry_run', v_row.dry_run,
    'money_path_executed', v_row.money_path_executed,
    'result_json', v_row.result_json
  );
END;
$fn$;

COMMENT ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) IS
  'Atomic claim per (occurrence_key, dry_run); dry-run never blocks production money path.';

COMMIT;
