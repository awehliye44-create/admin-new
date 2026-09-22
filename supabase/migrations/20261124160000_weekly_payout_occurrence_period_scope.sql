-- Freeze weekly occurrence earning period on claim.
-- Previous completed Europe/London calendar week only.
-- Does not mutate payout_batches, payout_items, reservations, intents,
-- wallets, destinations, or provider state. Does not create an occurrence row.

BEGIN;

ALTER TABLE public.weekly_payout_occurrence_runs
  ADD COLUMN IF NOT EXISTS period_start timestamptz,
  ADD COLUMN IF NOT EXISTS period_end timestamptz;

CREATE OR REPLACE FUNCTION public.weekly_payout_previous_completed_week(
  p_schedule_occurrence_key text
)
RETURNS TABLE (period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
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

CREATE OR REPLACE FUNCTION public.weekly_payout_occurrence_period_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
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

DROP TRIGGER IF EXISTS trg_weekly_payout_occurrence_period_immutable
  ON public.weekly_payout_occurrence_runs;
CREATE TRIGGER trg_weekly_payout_occurrence_period_immutable
  BEFORE UPDATE ON public.weekly_payout_occurrence_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.weekly_payout_occurrence_period_immutable();

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
  v_ps timestamptz;
  v_pe timestamptz;
BEGIN
  IF p_schedule_occurrence_key IS NULL OR length(trim(p_schedule_occurrence_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_occurrence_key');
  END IF;

  SELECT p.period_start, p.period_end
    INTO v_ps, v_pe
  FROM public.weekly_payout_previous_completed_week(trim(p_schedule_occurrence_key)) p;

  INSERT INTO public.weekly_payout_occurrence_runs (
    schedule_occurrence_key,
    status,
    dry_run,
    started_at,
    period_start,
    period_end
  )
  VALUES (
    trim(p_schedule_occurrence_key),
    'RUNNING',
    v_dry,
    now(),
    v_ps,
    v_pe
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
      'reused', false,
      'period_start', v_ps,
      'period_end', v_pe
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
    'reused', true,
    'period_start', v_run.period_start,
    'period_end', v_run.period_end
  );
END;
$claim$;

COMMENT ON FUNCTION public.weekly_payout_previous_completed_week(text) IS
  'Previous completed Europe/London calendar week for a weekly-payout occurrence key. Immutable relative to the key, not now().';

COMMENT ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) IS
  'Idempotent weekly occurrence claim. Identity is (schedule_occurrence_key, dry_run). Insert freezes period_start/period_end. Live and dry-run may coexist.';

REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.weekly_payout_previous_completed_week(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.weekly_payout_previous_completed_week(text) TO service_role;

COMMIT;
