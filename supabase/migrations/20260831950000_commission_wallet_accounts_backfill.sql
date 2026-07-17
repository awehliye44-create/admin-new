-- P0 — Commission Wallet accounts (non-financial profiles) + Africa driver backfill.
-- Profile creation is NOT a credit. Balances stay ledger-derived (zero until credits exist).
-- UNIQUE(driver_id, service_area_id). Safe to re-run. No driver_wallet_ledger writes.

BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_commission_wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  region_id uuid NOT NULL REFERENCES public.regions(id),
  currency text NOT NULL,
  source text NOT NULL DEFAULT 'backfill',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_commission_wallet_accounts_currency_chk
    CHECK (char_length(btrim(currency)) = 3),
  CONSTRAINT driver_commission_wallet_accounts_source_chk
    CHECK (source IN ('backfill', 'auto_assignment', 'sa_move', 'admin_repair')),
  CONSTRAINT driver_commission_wallet_accounts_driver_sa_uidx
    UNIQUE (driver_id, service_area_id)
);

CREATE INDEX IF NOT EXISTS driver_commission_wallet_accounts_sa_idx
  ON public.driver_commission_wallet_accounts (service_area_id, created_at DESC);

CREATE INDEX IF NOT EXISTS driver_commission_wallet_accounts_region_idx
  ON public.driver_commission_wallet_accounts (region_id);

COMMENT ON TABLE public.driver_commission_wallet_accounts IS
  'Non-financial Commission Wallet profile per (driver, service_area). '
  'Balances are derived from driver_commission_wallet_ledger only. '
  'Creating a row must never write TOP_UP_CREDIT / ADMIN_CREDIT / deductions.';

ALTER TABLE public.driver_commission_wallet_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commission_wallet_accounts_driver_read
  ON public.driver_commission_wallet_accounts;
CREATE POLICY commission_wallet_accounts_driver_read
  ON public.driver_commission_wallet_accounts
  FOR SELECT
  TO authenticated
  USING (
    driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())
  );

-- Idempotent ensure: create profile for CW-enabled SA only. Never writes ledger.
CREATE OR REPLACE FUNCTION public.ensure_driver_commission_wallet_account(
  p_driver_id uuid,
  p_service_area_id uuid,
  p_source text DEFAULT 'auto_assignment'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sa public.service_areas%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_currency text;
  v_region_id uuid;
  v_source text := COALESCE(NULLIF(btrim(p_source), ''), 'auto_assignment');
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_driver_id IS NULL OR p_service_area_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'MISSING_IDS',
      'error', 'driver_id and service_area_id required'
    );
  END IF;

  IF v_source NOT IN ('backfill', 'auto_assignment', 'sa_move', 'admin_repair') THEN
    v_source := 'auto_assignment';
  END IF;

  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'DRIVER_NOT_FOUND',
      'error', 'Driver not found or deleted'
    );
  END IF;

  -- Canonical assignment only — never trip/GPS/city inference.
  IF v_driver.service_area_id IS DISTINCT FROM p_service_area_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA',
      'error', 'Driver canonical service_area_id does not match requested service area'
    );
  END IF;

  SELECT * INTO v_sa
  FROM public.service_areas
  WHERE id = p_service_area_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'SERVICE_AREA_NOT_FOUND',
      'error', 'Service area not found'
    );
  END IF;

  IF NOT public.is_commission_wallet_workflow_enabled(p_service_area_id) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'COMMISSION_WALLET_DISABLED',
      'error', 'Service area is not Commission Wallet enabled'
    );
  END IF;

  v_currency := upper(btrim(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    (
      SELECT r.currency_code
      FROM public.regions r
      WHERE r.id = v_sa.region_id
    )
  )));

  IF v_currency IS NULL OR char_length(v_currency) <> 3 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'CURRENCY_REQUIRED',
      'error', 'Service area has no commission wallet currency configured'
    );
  END IF;

  v_region_id := COALESCE(v_sa.region_id, v_driver.region_id);
  IF v_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'created', false,
      'code', 'REGION_REQUIRED',
      'error', 'Service area has no region_id'
    );
  END IF;

  SELECT id INTO v_existing
  FROM public.driver_commission_wallet_accounts
  WHERE driver_id = p_driver_id
    AND service_area_id = p_service_area_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'created', false,
      'already_present', true,
      'account_id', v_existing,
      'driver_id', p_driver_id,
      'service_area_id', p_service_area_id,
      'currency', v_currency,
      'region_id', v_region_id
    );
  END IF;

  INSERT INTO public.driver_commission_wallet_accounts (
    driver_id,
    service_area_id,
    region_id,
    currency,
    source
  ) VALUES (
    p_driver_id,
    p_service_area_id,
    v_region_id,
    v_currency,
    v_source
  )
  ON CONFLICT (driver_id, service_area_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.driver_commission_wallet_accounts
    WHERE driver_id = p_driver_id
      AND service_area_id = p_service_area_id;
    RETURN jsonb_build_object(
      'ok', true,
      'created', false,
      'already_present', true,
      'account_id', v_id,
      'driver_id', p_driver_id,
      'service_area_id', p_service_area_id,
      'currency', v_currency,
      'region_id', v_region_id
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'created', true,
    'already_present', false,
    'account_id', v_id,
    'driver_id', p_driver_id,
    'service_area_id', p_service_area_id,
    'currency', v_currency,
    'region_id', v_region_id,
    'source', v_source
  );
END;
$$;

COMMENT ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text) IS
  'Idempotent non-financial CW profile ensure. Never writes ledger credits or driver_wallet_ledger.';

GRANT EXECUTE ON FUNCTION public.ensure_driver_commission_wallet_account(uuid, uuid, text)
  TO service_role;

-- Auto-create on assign / SA move (new SA only). Never transfers balances.
CREATE OR REPLACE FUNCTION public.trg_ensure_commission_wallet_account_on_driver_sa()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source text;
BEGIN
  IF NEW.service_area_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.service_area_id IS NOT DISTINCT FROM NEW.service_area_id
  THEN
    RETURN NEW;
  END IF;

  IF NOT public.is_commission_wallet_workflow_enabled(NEW.service_area_id) THEN
    RETURN NEW;
  END IF;

  v_source := CASE
    WHEN TG_OP = 'UPDATE'
      AND OLD.service_area_id IS NOT NULL
      AND OLD.service_area_id IS DISTINCT FROM NEW.service_area_id
    THEN 'sa_move'
    ELSE 'auto_assignment'
  END;

  PERFORM public.ensure_driver_commission_wallet_account(
    NEW.id,
    NEW.service_area_id,
    v_source
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ensure_cw_account_on_driver_sa ON public.drivers;
CREATE TRIGGER trg_ensure_cw_account_on_driver_sa
  AFTER INSERT OR UPDATE OF service_area_id
  ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_ensure_commission_wallet_account_on_driver_sa();

COMMENT ON FUNCTION public.trg_ensure_commission_wallet_account_on_driver_sa() IS
  'Creates CW account for destination SA when assigned. Preserves old SA accounts; never transfers balances.';

-- Idempotent Africa backfill with proof payload.
CREATE OR REPLACE FUNCTION public.backfill_driver_commission_wallet_accounts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_result jsonb;
  v_eligible int := 0;
  v_created int := 0;
  v_already int := 0;
  v_skip_no_sa int := 0;
  v_skip_disabled int := 0;
  v_skip_currency int := 0;
  v_skip_other int := 0;
  v_skip_not_assigned int := 0;
  v_ledger_before bigint;
  v_ledger_after bigint;
  v_dwl_before bigint;
  v_dwl_after bigint;
  v_uk_eu_drivers bigint;
  v_uk_eu_accounts bigint;
BEGIN
  SELECT count(*) INTO v_ledger_before FROM public.driver_commission_wallet_ledger;
  SELECT count(*) INTO v_dwl_before FROM public.driver_wallet_ledger;

  SELECT count(*) INTO v_uk_eu_drivers
  FROM public.drivers d
  JOIN public.service_areas sa ON sa.id = d.service_area_id
  WHERE d.deleted_at IS NULL
    AND (
      sa.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET'
      OR sa.commission_wallet_enabled IS DISTINCT FROM true
    );

  FOR r IN
    SELECT
      d.id AS driver_id,
      d.service_area_id,
      public.is_commission_wallet_workflow_enabled(d.service_area_id) AS cw_enabled
    FROM public.drivers d
    WHERE d.deleted_at IS NULL
  LOOP
    IF r.service_area_id IS NULL THEN
      v_skip_no_sa := v_skip_no_sa + 1;
      CONTINUE;
    END IF;

    IF r.cw_enabled IS NOT TRUE THEN
      v_skip_disabled := v_skip_disabled + 1;
      CONTINUE;
    END IF;

    v_eligible := v_eligible + 1;
    v_result := public.ensure_driver_commission_wallet_account(
      r.driver_id,
      r.service_area_id,
      'backfill'
    );

    IF (v_result->>'ok')::boolean IS TRUE THEN
      IF (v_result->>'created')::boolean IS TRUE THEN
        v_created := v_created + 1;
      ELSE
        v_already := v_already + 1;
      END IF;
    ELSE
      -- Counted eligible but ensure failed — reclassify
      v_eligible := v_eligible - 1;
      IF v_result->>'code' = 'CURRENCY_REQUIRED' THEN
        v_skip_currency := v_skip_currency + 1;
      ELSIF v_result->>'code' = 'DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA' THEN
        v_skip_not_assigned := v_skip_not_assigned + 1;
      ELSE
        v_skip_other := v_skip_other + 1;
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_ledger_after FROM public.driver_commission_wallet_ledger;
  SELECT count(*) INTO v_dwl_after FROM public.driver_wallet_ledger;

  SELECT count(*) INTO v_uk_eu_accounts
  FROM public.driver_commission_wallet_accounts a
  JOIN public.service_areas sa ON sa.id = a.service_area_id
  WHERE sa.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET'
     OR sa.commission_wallet_enabled IS DISTINCT FROM true;

  RETURN jsonb_build_object(
    'ok', true,
    'eligible_existing_drivers', v_eligible,
    'wallet_profiles_created', v_created,
    'already_present', v_already,
    'skipped', jsonb_build_array(
      jsonb_build_object('reason', 'NO_SERVICE_AREA', 'count', v_skip_no_sa),
      jsonb_build_object(
        'reason', 'COMMISSION_WALLET_DISABLED_OR_PLATFORM_COLLECTED',
        'count', v_skip_disabled
      ),
      jsonb_build_object('reason', 'CURRENCY_REQUIRED', 'count', v_skip_currency),
      jsonb_build_object('reason', 'DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA', 'count', v_skip_not_assigned),
      jsonb_build_object('reason', 'OTHER_ENSURE_FAILURE', 'count', v_skip_other)
    ),
    'financial_credit_entries_created', GREATEST(0, v_ledger_after - v_ledger_before),
    'commission_wallet_ledger_rows_before', v_ledger_before,
    'commission_wallet_ledger_rows_after', v_ledger_after,
    'driver_wallet_ledger_rows_before', v_dwl_before,
    'driver_wallet_ledger_rows_after', v_dwl_after,
    'driver_wallet_ledger_untouched', v_dwl_before = v_dwl_after,
    'uk_eu_drivers_with_non_cw_sa', v_uk_eu_drivers,
    'uk_eu_cw_accounts_created', v_uk_eu_accounts,
    'uk_eu_finance_workflows_untouched',
      (v_dwl_before = v_dwl_after)
      AND (v_ledger_after = v_ledger_before)
      AND (v_uk_eu_accounts = 0)
  );
END;
$$;

COMMENT ON FUNCTION public.backfill_driver_commission_wallet_accounts() IS
  'Idempotent Africa CW account backfill. Never creates financial ledger credits.';

GRANT EXECUTE ON FUNCTION public.backfill_driver_commission_wallet_accounts()
  TO service_role;

COMMIT;
