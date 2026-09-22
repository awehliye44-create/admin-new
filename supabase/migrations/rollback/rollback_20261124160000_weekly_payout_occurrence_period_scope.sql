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

-- Restore pre-lock occupancy trigger (check without driver advisory / ledger FOR UPDATE).
CREATE OR REPLACE FUNCTION public.trg_payout_item_ledger_allocations_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_ledger public.driver_wallet_ledger%ROWTYPE;
  v_model text;
  v_other integer;
BEGIN
  IF NEW.payout_item_id IS NULL THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: allocation payout_item_id cannot be null'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ledger_entry_id IS NULL THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: allocation ledger_entry_id cannot be null'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_pence IS NULL OR NEW.amount_pence <= 0 THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: allocation amount must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_item FROM public.payout_items WHERE id = NEW.payout_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: payout item % not found', NEW.payout_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_ledger FROM public.driver_wallet_ledger WHERE id = NEW.ledger_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISSING: ledger entry % not found', NEW.ledger_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ledger.driver_id IS DISTINCT FROM v_item.driver_id THEN
    RAISE EXCEPTION 'PAYOUT_LINEAGE_MISMATCH: ledger belongs to a different driver'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.payout_ledger_type_is_payout_eligible(v_ledger.type) THEN
    RAISE EXCEPTION
      'PAYOUT_LINEAGE_MISMATCH: ledger type % is not payout-eligible',
      v_ledger.type
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_ledger.related_trip_id IS NOT NULL THEN
    SELECT financial_model::text INTO v_model FROM public.trips WHERE id = v_ledger.related_trip_id;
    IF coalesce(v_model, '') = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
      RAISE EXCEPTION
        'FINANCIAL_MODEL_VIOLATION: Driver-Collected trip entries cannot enter Payout Ledger'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
      RAISE EXCEPTION
        'PAYOUT_LINEAGE_MISMATCH: trip-linked ledger must belong to PLATFORM_COLLECTED'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT coalesce(sum(a.amount_pence), 0) INTO v_other
  FROM public.payout_item_ledger_allocations a
  JOIN public.payout_items pi ON pi.id = a.payout_item_id
  WHERE a.ledger_entry_id = NEW.ledger_entry_id
    AND a.id IS DISTINCT FROM NEW.id
    AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status);

  IF v_other + NEW.amount_pence > greatest(v_ledger.amount_pence, 0) THEN
    RAISE EXCEPTION
      'PAYOUT_LINEAGE_MISMATCH: ledger entry already allocated to a successful/reserved payout'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
