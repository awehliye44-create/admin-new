-- P0: Weekly payout occurrence claim + retarget cron to orchestrator edge.
-- LIVE_PAYOUT_EXECUTION_ENABLED stays false until explicit rollout.

BEGIN;

CREATE TABLE IF NOT EXISTS public.weekly_payout_occurrence_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_occurrence_key TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status = ANY (ARRAY[
      'CLAIMED'::text,
      'RUNNING'::text,
      'COMPLETED'::text,
      'BLOCKED'::text,
      'FAILED'::text
    ])),
  batch_id UUID REFERENCES public.payout_batches(id),
  blocker_code TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT false,
  money_path_executed BOOLEAN NOT NULL DEFAULT false,
  required_batch_pence INTEGER,
  funding_available_pence INTEGER,
  funding_result TEXT,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_payout_occurrence_runs_key
  ON public.weekly_payout_occurrence_runs (schedule_occurrence_key);

CREATE INDEX IF NOT EXISTS idx_weekly_payout_occurrence_runs_status
  ON public.weekly_payout_occurrence_runs (status, claimed_at DESC);

COMMENT ON TABLE public.weekly_payout_occurrence_runs IS
  'Atomic claim/reconcile for weekly payout orchestrator; later cron ticks reuse, never duplicate pay/debit.';

ALTER TABLE public.payout_batches
  ADD COLUMN IF NOT EXISTS blocker_code TEXT;

-- Atomic claim: insert CLAIMED or return existing row.
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
BEGIN
  IF p_schedule_occurrence_key IS NULL OR length(trim(p_schedule_occurrence_key)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_occurrence_key');
  END IF;

  INSERT INTO public.weekly_payout_occurrence_runs (
    schedule_occurrence_key, status, dry_run, claimed_at
  ) VALUES (
    trim(p_schedule_occurrence_key), 'CLAIMED', coalesce(p_dry_run, false), now()
  )
  ON CONFLICT (schedule_occurrence_key) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    v_inserted := true;
  ELSE
    SELECT * INTO v_row
    FROM public.weekly_payout_occurrence_runs
    WHERE schedule_occurrence_key = trim(p_schedule_occurrence_key);
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

REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(TEXT, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_weekly_payout_occurrence(
  p_run_id UUID,
  p_status TEXT,
  p_batch_id UUID DEFAULT NULL,
  p_blocker_code TEXT DEFAULT NULL,
  p_required_batch_pence INTEGER DEFAULT NULL,
  p_funding_available_pence INTEGER DEFAULT NULL,
  p_funding_result TEXT DEFAULT NULL,
  p_money_path_executed BOOLEAN DEFAULT false,
  p_result_json JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_row public.weekly_payout_occurrence_runs%ROWTYPE;
BEGIN
  UPDATE public.weekly_payout_occurrence_runs
  SET
    status = p_status,
    batch_id = coalesce(p_batch_id, batch_id),
    blocker_code = p_blocker_code,
    required_batch_pence = p_required_batch_pence,
    funding_available_pence = p_funding_available_pence,
    funding_result = p_funding_result,
    money_path_executed = coalesce(p_money_path_executed, false),
    result_json = coalesce(p_result_json, '{}'::jsonb),
    started_at = coalesce(started_at, now()),
    finished_at = now(),
    updated_at = now()
  WHERE id = p_run_id
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'run_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'run_id', v_row.id,
    'status', v_row.status,
    'blocker_code', v_row.blocker_code
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.finish_weekly_payout_occurrence(UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finish_weekly_payout_occurrence(UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, BOOLEAN, JSONB) TO service_role;

-- Retarget cron invoke to orchestrator edge (same auth pattern as Slice 5).
CREATE OR REPLACE FUNCTION public.invoke_weekly_payout_scheduler()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_weekly_payout_orchestrator_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/admin-execute-weekly-payout-occurrence'
  );
  v_token text := public.cron_edge_auth_token();
  v_cron_secret text := coalesce(
    nullif(trim(current_setting('app.settings.cron_secret', true)), ''),
    nullif(trim(current_setting('app.settings.onecab_internal_finalize_secret', true)), '')
  );
BEGIN
  IF v_url IS NULL OR length(trim(v_url)) < 20 OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[weekly-payout-orchestrator] aborted reason=bad_url_or_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token,
        'x-onecab-cron-secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      )),
      body := jsonb_strip_nulls(jsonb_build_object(
        'scheduled', true,
        'source', 'pg_cron',
        'cron_secret', CASE
          WHEN v_cron_secret IS NOT NULL AND length(trim(v_cron_secret)) >= 20 THEN v_cron_secret
          ELSE NULL
        END
      ))
    );
    RAISE LOG '[weekly-payout-orchestrator] edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[weekly-payout-orchestrator] edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
  END;
END;
$fn$;

COMMENT ON FUNCTION public.invoke_weekly_payout_scheduler() IS
  'pg_cron: invoke admin-execute-weekly-payout-occurrence (full orchestrator). Settings-driven day/time; soft-skips off-schedule.';

-- Ensure job still scheduled at */15.
DO $$
BEGIN
  PERFORM cron.unschedule('weekly-payout-scheduler');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'weekly-payout-scheduler',
  '*/15 * * * *',
  $$SELECT public.invoke_weekly_payout_scheduler();$$
);

COMMIT;
