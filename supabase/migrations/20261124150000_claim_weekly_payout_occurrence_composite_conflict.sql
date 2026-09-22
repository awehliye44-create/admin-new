-- Align claim_weekly_payout_occurrence ON CONFLICT with the live composite unique
-- index UNIQUE (schedule_occurrence_key, dry_run).
--
-- Provenance: 20260832010000 is already applied and still uses
-- ON CONFLICT (schedule_occurrence_key). That target no longer matches live
-- uniqueness (out-of-band composite index uq_weekly_payout_occurrence_runs_key_dry).
-- Do not re-apply or rename 20260832010000.
--
-- Does not mutate payout_batches, payout_items, reservations, intents, wallets,
-- destinations, or provider state. Does not create an occurrence row.

BEGIN;

-- Preserve intended identity: live and dry-run may coexist; same-mode duplicates cannot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_payout_occurrence_runs_key_dry
  ON public.weekly_payout_occurrence_runs (schedule_occurrence_key, dry_run);

-- Single-column unique would forbid dry-run + live coexistence (two historical keys).
ALTER TABLE public.weekly_payout_occurrence_runs
  DROP CONSTRAINT IF EXISTS weekly_payout_occurrence_runs_schedule_occurrence_key_key;

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

COMMENT ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) IS
  'Idempotent weekly occurrence claim. Identity is (schedule_occurrence_key, dry_run). Live and dry-run may coexist. ON CONFLICT matches UNIQUE (schedule_occurrence_key, dry_run).';

REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) TO service_role;

COMMIT;
