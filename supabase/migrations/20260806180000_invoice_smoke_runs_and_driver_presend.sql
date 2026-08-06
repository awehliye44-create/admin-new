-- Invoice smoke run budget + driver invoice lifecycle/validation metadata.
-- Does not activate schedulers.
-- v2: reserved slots; successful count increments only after provider accept.

CREATE TABLE IF NOT EXISTS public.invoice_smoke_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  smoke_run_id text NOT NULL UNIQUE,
  project_ref text NOT NULL DEFAULT 'thazislrdkjpvvghtvzo',
  environment text NOT NULL DEFAULT 'development',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'failed', 'passed')),
  max_successful_sends integer NOT NULL DEFAULT 4
    CHECK (max_successful_sends >= 0 AND max_successful_sends <= 20),
  successful_send_count integer NOT NULL DEFAULT 0
    CHECK (successful_send_count >= 0),
  attempted_send_count integer NOT NULL DEFAULT 0
    CHECK (attempted_send_count >= 0),
  reserved_send_count integer NOT NULL DEFAULT 0
    CHECK (reserved_send_count >= 0),
  allowlisted_customer_ids uuid[] NOT NULL DEFAULT '{}',
  allowlisted_driver_ids uuid[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Historical failed runs may exceed the intended max (oversend evidence).
ALTER TABLE public.invoice_smoke_runs
  DROP CONSTRAINT IF EXISTS invoice_smoke_runs_success_lte_max;

ALTER TABLE public.invoice_smoke_runs
  ADD COLUMN IF NOT EXISTS reserved_send_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS invoice_smoke_runs_status_idx
  ON public.invoice_smoke_runs (status, opened_at DESC);

COMMENT ON TABLE public.invoice_smoke_runs IS
  'Controlled invoice smoke budgets. Provider sends must acquire a reserved slot atomically; successful count increments only after provider accept.';

-- Lifecycle / validation columns on invoices.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS lifecycle_status text,
  ADD COLUMN IF NOT EXISTS zero_total_classification text,
  ADD COLUMN IF NOT EXISTS aggregation_included_row_count integer,
  ADD COLUMN IF NOT EXISTS aggregation_scope text,
  ADD COLUMN IF NOT EXISTS validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS validation_error text,
  ADD COLUMN IF NOT EXISTS smoke_run_id text,
  ADD COLUMN IF NOT EXISTS superseded_by_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS supersedes_invoice_id uuid,
  ADD COLUMN IF NOT EXISTS test_error_reason_code text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS validation_fingerprint text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.invoices'::regclass
      AND conname = 'invoices_status_check'
  ) THEN
    ALTER TABLE public.invoices DROP CONSTRAINT invoices_status_check;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (
    status IS NULL OR status IN (
      'draft', 'aggregating', 'validated', 'generated', 'send_pending', 'sent',
      'finalized', 'viewed', 'cancelled', 'failed',
      'superseded_test_error', 'voided_test_error'
    )
  );

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_lifecycle_status_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_lifecycle_status_check
  CHECK (
    lifecycle_status IS NULL OR lifecycle_status IN (
      'DRAFT', 'AGGREGATING', 'VALIDATED', 'GENERATED', 'SEND_PENDING', 'SENT',
      'SKIPPED_NO_VALID_EMAIL', 'FAILED', 'SUPERSEDED_TEST_ERROR', 'VOIDED_TEST_ERROR'
    )
  );

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_zero_total_classification_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_zero_total_classification_check
  CHECK (
    zero_total_classification IS NULL OR zero_total_classification IN (
      'VALID_ZERO_EARNINGS', 'INVALID_AGGREGATION', 'INCOMPLETE_AGGREGATION'
    )
  );

-- Reserve a send slot before the provider API call (does NOT increment successful).
CREATE OR REPLACE FUNCTION public.acquire_invoice_smoke_send_slot(p_smoke_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.invoice_smoke_runs%ROWTYPE;
BEGIN
  IF p_smoke_run_id IS NULL OR length(trim(p_smoke_run_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SMOKE_RUN_REQUIRED');
  END IF;

  SELECT * INTO r
  FROM public.invoice_smoke_runs
  WHERE smoke_run_id = p_smoke_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SMOKE_RUN_NOT_FOUND');
  END IF;

  IF r.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SMOKE_RUN_CLOSED', 'status', r.status);
  END IF;

  UPDATE public.invoice_smoke_runs
  SET attempted_send_count = attempted_send_count + 1,
      updated_at = now()
  WHERE id = r.id
  RETURNING * INTO r;

  IF (r.successful_send_count + r.reserved_send_count) >= r.max_successful_sends THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'SMOKE_SEND_LIMIT_REACHED',
      'successful_send_count', r.successful_send_count,
      'reserved_send_count', r.reserved_send_count,
      'max_successful_sends', r.max_successful_sends,
      'attempted_send_count', r.attempted_send_count
    );
  END IF;

  UPDATE public.invoice_smoke_runs
  SET reserved_send_count = reserved_send_count + 1,
      updated_at = now()
  WHERE id = r.id
  RETURNING * INTO r;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'SLOT_ACQUIRED',
    'successful_send_count', r.successful_send_count,
    'reserved_send_count', r.reserved_send_count,
    'max_successful_sends', r.max_successful_sends,
    'attempted_send_count', r.attempted_send_count
  );
END;
$$;

-- Provider accepted: convert reservation into successful count.
CREATE OR REPLACE FUNCTION public.confirm_invoice_smoke_send_slot(p_smoke_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.invoice_smoke_runs%ROWTYPE;
BEGIN
  SELECT * INTO r
  FROM public.invoice_smoke_runs
  WHERE smoke_run_id = p_smoke_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SMOKE_RUN_NOT_FOUND');
  END IF;

  UPDATE public.invoice_smoke_runs
  SET reserved_send_count = GREATEST(0, reserved_send_count - 1),
      successful_send_count = successful_send_count + 1,
      updated_at = now()
  WHERE id = r.id
  RETURNING * INTO r;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'SLOT_CONFIRMED',
    'successful_send_count', r.successful_send_count,
    'reserved_send_count', r.reserved_send_count,
    'max_successful_sends', r.max_successful_sends
  );
END;
$$;

-- Provider failed after reservation: free the reserved slot (do not increment successful).
CREATE OR REPLACE FUNCTION public.release_invoice_smoke_send_slot(p_smoke_run_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.invoice_smoke_runs%ROWTYPE;
BEGIN
  SELECT * INTO r
  FROM public.invoice_smoke_runs
  WHERE smoke_run_id = p_smoke_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SMOKE_RUN_NOT_FOUND');
  END IF;

  UPDATE public.invoice_smoke_runs
  SET reserved_send_count = GREATEST(0, reserved_send_count - 1),
      updated_at = now()
  WHERE id = r.id
  RETURNING * INTO r;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'SLOT_RELEASED',
    'successful_send_count', r.successful_send_count,
    'reserved_send_count', r.reserved_send_count,
    'max_successful_sends', r.max_successful_sends
  );
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_invoice_smoke_send_slot(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_invoice_smoke_send_slot(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_invoice_smoke_send_slot(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_invoice_smoke_send_slot(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_invoice_smoke_send_slot(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_invoice_smoke_send_slot(text) TO service_role;

-- Drop period uniqueness before reclassifying the £0 invoice (cancelled → superseded
-- would otherwise re-enter the old unique index and collide with INV-2608-003).
DROP INDEX IF EXISTS public.invoices_driver_period_unique;

-- Preserve failed run evidence (do not delete provider history).
INSERT INTO public.invoice_smoke_runs (
  smoke_run_id, project_ref, environment, status,
  max_successful_sends, successful_send_count, attempted_send_count, reserved_send_count,
  allowlisted_customer_ids, allowlisted_driver_ids, metadata, opened_at, closed_at
) VALUES (
  'SMOKE-FAIL-20260806-INVOICE-V1',
  'thazislrdkjpvvghtvzo',
  'development',
  'failed',
  4,
  5,
  5,
  0,
  ARRAY[
    'a0032fdf-fb18-480d-8a15-4f45f87c103b'::uuid,
    '2533c691-1f5f-4000-a05c-e4cad6c725a2'::uuid,
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'::uuid
  ],
  ARRAY[
    '5ed232c3-8bb5-4085-95d6-73e48e6c5e28'::uuid,
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0002'::uuid
  ],
  jsonb_build_object(
    'verdict', 'FAIL',
    'root_cause', 'service-area-null aggregation filter returned zero',
    'secondary_control_failure', 'email delivery occurred before financial validation completed',
    'erroneous_invoice', 'INV-2608-001',
    'replacement_invoice', 'INV-2608-003',
    'reason_code', 'DRIVER_INVOICE_ZERO_TOTAL_AGGREGATION_DEFECT',
    'successful_provider_deliveries', 5
  ),
  '2026-08-06T15:20:00Z',
  '2026-08-06T15:35:00Z'
)
ON CONFLICT (smoke_run_id) DO UPDATE SET
  status = EXCLUDED.status,
  successful_send_count = EXCLUDED.successful_send_count,
  attempted_send_count = EXCLUDED.attempted_send_count,
  reserved_send_count = EXCLUDED.reserved_send_count,
  metadata = EXCLUDED.metadata,
  closed_at = EXCLUDED.closed_at,
  updated_at = now();

-- Mark £0 invoice as superseded test error (immutable email evidence retained).
UPDATE public.invoices i
SET
  status = 'superseded_test_error',
  lifecycle_status = 'SUPERSEDED_TEST_ERROR',
  smoke_run_id = 'SMOKE-FAIL-20260806-INVOICE-V1',
  test_error_reason_code = 'DRIVER_INVOICE_ZERO_TOTAL_AGGREGATION_DEFECT',
  superseded_by_invoice_id = '57e19026-5de1-4af0-95b6-174d23ae97ad',
  zero_total_classification = 'INVALID_AGGREGATION',
  validation_error = 'Aggregation returned zero due to null service_area_id filter eliminating eligible ledger rows',
  invoice_email_error = coalesce(invoice_email_error, '') ||
    ' | SUPERSEDED_TEST_ERROR DRIVER_INVOICE_ZERO_TOTAL_AGGREGATION_DEFECT'
WHERE i.id = '0eb8fed9-de69-4e5c-9d0e-3c415e32dc10'
  AND i.invoice_number = 'INV-2608-001';

UPDATE public.invoices
SET
  smoke_run_id = 'SMOKE-FAIL-20260806-INVOICE-V1',
  supersedes_invoice_id = '0eb8fed9-de69-4e5c-9d0e-3c415e32dc10'
WHERE id = '57e19026-5de1-4af0-95b6-174d23ae97ad'
  AND invoice_number = 'INV-2608-003';

-- Unique period index must ignore voided/superseded test-error rows.
CREATE UNIQUE INDEX invoices_driver_period_unique
  ON public.invoices (driver_id, region_id, period_start, period_end)
  WHERE driver_id IS NOT NULL
    AND period_start IS NOT NULL
    AND period_end IS NOT NULL
    AND COALESCE(status, '') NOT IN (
      'cancelled', 'superseded_test_error', 'voided_test_error'
    );

-- Customer smoke trips from failed run — tag only, do not resend.
UPDATE public.trips
SET fare_snapshot_json = coalesce(fare_snapshot_json, '{}'::jsonb) ||
  jsonb_build_object('smoke_run_id', 'SMOKE-FAIL-20260806-INVOICE-V1')
WHERE id IN (
  'f6b15f03-fb48-49cd-bb18-b66b0cf2316d',
  'af3919df-3a2f-4968-bc2f-7a61705eae68',
  'e556e419-afc7-4f3b-ae40-c5f97b93599a',
  'e80b5da1-b3ae-49a4-baca-7028c807e3e1'
);
