-- Canonical weekly payout orchestrator: occurrence claim/finish RPCs + cron retarget.
-- Replaces obsolete admin-weekly-payout-scheduler edge route with admin-execute-weekly-payout-occurrence.

BEGIN;

CREATE TABLE IF NOT EXISTS public.weekly_payout_occurrence_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_occurrence_key text NOT NULL,
  status text NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  batch_id uuid REFERENCES public.payout_batches(id) ON DELETE SET NULL,
  blocker_code text,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  money_path_executed boolean NOT NULL DEFAULT false,
  required_batch_pence integer,
  funding_available_pence integer,
  funding_result text,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT weekly_payout_occurrence_runs_schedule_occurrence_key_key UNIQUE (schedule_occurrence_key)
);

CREATE INDEX IF NOT EXISTS idx_weekly_payout_occurrence_runs_status
  ON public.weekly_payout_occurrence_runs (status, finished_at DESC);

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

CREATE OR REPLACE FUNCTION public.finish_weekly_payout_occurrence(
  p_run_id uuid,
  p_status text,
  p_batch_id uuid DEFAULT NULL,
  p_blocker_code text DEFAULT NULL,
  p_required_batch_pence integer DEFAULT NULL,
  p_funding_available_pence integer DEFAULT NULL,
  p_funding_result text DEFAULT NULL,
  p_money_path_executed boolean DEFAULT false,
  p_result_json jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $finish$
DECLARE
  v_updated uuid;
BEGIN
  IF p_run_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_run_id');
  END IF;

  UPDATE public.weekly_payout_occurrence_runs
  SET
    status = coalesce(nullif(trim(p_status), ''), status),
    batch_id = coalesce(p_batch_id, batch_id),
    blocker_code = p_blocker_code,
    required_batch_pence = p_required_batch_pence,
    funding_available_pence = p_funding_available_pence,
    funding_result = p_funding_result,
    money_path_executed = coalesce(p_money_path_executed, money_path_executed),
    result_json = coalesce(p_result_json, result_json),
    finished_at = now(),
    updated_at = now()
  WHERE id = p_run_id
  RETURNING id INTO v_updated;

  IF v_updated IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'run_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'run_id', v_updated);
END;
$finish$;

REVOKE ALL ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_weekly_payout_occurrence(uuid, text, uuid, text, integer, integer, text, boolean, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_weekly_payout_occurrence(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_weekly_payout_occurrence(uuid, text, uuid, text, integer, integer, text, boolean, jsonb) TO service_role;

-- Retarget pg_cron → canonical orchestrator (settings-driven day/time; idempotent occurrence claim).
CREATE OR REPLACE FUNCTION public.invoke_weekly_payout_scheduler()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_weekly_payout_orchestrator_url', true)), ''),
    nullif(trim(current_setting('app.settings.edge_weekly_payout_scheduler_url', true)), ''),
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
  'pg_cron: invoke admin-execute-weekly-payout-occurrence (canonical orchestrator). Settings-driven day/time; occurrence idempotency via claim_weekly_payout_occurrence.';

COMMIT;
