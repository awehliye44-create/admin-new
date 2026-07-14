-- P0 Slice 5: weekly scheduled payout batch workflow schema.
-- Deterministic schedule_occurrence_key; Slice 5 statuses; no wallet mutation.
-- LIVE_PAYOUT_EXECUTION_ENABLED / REVOLUT_PAYMENT_TRANSPORT_ENABLED stay false.

BEGIN;

-- Retire Monday-only kind constraint; add WEEKLY_SCHEDULED.
ALTER TABLE public.payout_batches DROP CONSTRAINT IF EXISTS payout_batches_kind_check;
ALTER TABLE public.payout_batches
  ADD CONSTRAINT payout_batches_kind_check
  CHECK (kind = ANY (ARRAY[
    'WEEKLY_MONDAY'::text,
    'WEEKLY_SCHEDULED'::text,
    'EARLY_CASHOUT'::text,
    'MANUAL_ADMIN'::text
  ]));

ALTER TABLE public.payout_batches
  ADD COLUMN IF NOT EXISTS service_area_id UUID,
  ADD COLUMN IF NOT EXISTS schedule_id TEXT,
  ADD COLUMN IF NOT EXISTS schedule_occurrence_key TEXT,
  ADD COLUMN IF NOT EXISTS frequency TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_local_at TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_utc_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'GBP',
  ADD COLUMN IF NOT EXISTS eligible_driver_count INTEGER DEFAULT 0;

-- Unique occurrence — retries cannot duplicate a batch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_batches_schedule_occurrence_key
  ON public.payout_batches (schedule_occurrence_key)
  WHERE schedule_occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payout_batches_service_area_id
  ON public.payout_batches (service_area_id)
  WHERE service_area_id IS NOT NULL;

-- Widen batch status for Slice 5 lifecycle (keep legacy values).
ALTER TABLE public.payout_batches DROP CONSTRAINT IF EXISTS payout_batches_status_check;
ALTER TABLE public.payout_batches ADD CONSTRAINT payout_batches_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'partial', 'PARTIAL_SETTLEMENT',
    'INVALID_ORPHANED', 'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'RETURNED',
    'DRAFT', 'SCHEDULED', 'VALIDATING', 'PROCESSING', 'PARTIALLY_COMPLETED',
    'COMPLETED', 'FAILED', 'CANCELLED',
    'ELIGIBILITY_SNAPSHOTTED', 'ITEMS_CREATED', 'BLOCKED_EXECUTION_DISABLED'
  ]));

-- Payout item Slice 5 columns.
ALTER TABLE public.payout_items
  ADD COLUMN IF NOT EXISTS payout_destination_id UUID,
  ADD COLUMN IF NOT EXISTS provider_counterparty_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_recipient_account_id TEXT,
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'GBP',
  ADD COLUMN IF NOT EXISTS wallet_snapshot_balance_pence INTEGER,
  ADD COLUMN IF NOT EXISTS wallet_snapshot_available_pence INTEGER,
  ADD COLUMN IF NOT EXISTS eligibility_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS execution_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_request_id TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'ledger_sync_failed',
    'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'FAILED', 'RETURNED', 'INVALID_ORPHANED',
    'VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'INELIGIBLE'
  ]));

-- One item per batch+driver.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_items_batch_driver_unique
  ON public.payout_items (batch_id, driver_id)
  WHERE batch_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_items_provider_request_id
  ON public.payout_items (provider_request_id)
  WHERE provider_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_items_idempotency_key
  ON public.payout_items (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Seed/update canonical Tuesday 12:00 Europe/London settings (no Monday/01:00).
INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES
  ('weekly_payout_day', '"tuesday"', 'Day of week for automatic weekly payouts (Payout Ledger Settings SSOT)'),
  ('payout_processing_time', '"12:00"', 'Local processing time for weekly payouts'),
  ('payout_timezone', '"Europe/London"', 'IANA timezone for payout day/time gates'),
  ('payout_frequency', '"weekly"', 'Automatic payout frequency'),
  ('payouts_enabled', 'true', 'Whether automatic driver payouts are enabled')
ON CONFLICT (setting_key) DO UPDATE
SET
  setting_value = EXCLUDED.setting_value,
  description = COALESCE(EXCLUDED.description, admin_settings.description);

-- Point cron at canonical Slice 5 scheduler (day-agnostic; settings-driven).
CREATE OR REPLACE FUNCTION public.invoke_weekly_payout_scheduler()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_weekly_payout_scheduler_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/admin-weekly-payout-scheduler'
  );
  v_token text := public.cron_edge_auth_token();
  v_cron_secret text := coalesce(
    nullif(trim(current_setting('app.settings.cron_secret', true)), ''),
    nullif(trim(current_setting('app.settings.onecab_internal_finalize_secret', true)), '')
  );
BEGIN
  IF v_url IS NULL OR length(trim(v_url)) < 20 OR v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[weekly-payout-scheduler] aborted reason=bad_url_or_token';
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
    RAISE LOG '[weekly-payout-scheduler] edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[weekly-payout-scheduler] edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
  END;
END;
$fn$;

COMMENT ON FUNCTION public.invoke_weekly_payout_scheduler() IS
  'pg_cron: invoke admin-weekly-payout-scheduler (Slice 5). Settings-driven day/time; soft-skips off-schedule.';

-- Ensure job exists at */15 (idempotent re-schedule).
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
