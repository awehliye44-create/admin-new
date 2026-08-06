-- Configurable N-month driver earnings invoice cadence (example: every 8 months).
-- Does not hardcode 8 — admins set interval_months via Admin Reports.

ALTER TABLE public.statement_schedule_configs
  ADD COLUMN IF NOT EXISTS interval_months INTEGER;

ALTER TABLE public.statement_schedule_configs
  DROP CONSTRAINT IF EXISTS statement_schedule_configs_frequency_check;

ALTER TABLE public.statement_schedule_configs
  ADD CONSTRAINT statement_schedule_configs_frequency_check
  CHECK (frequency IN ('monthly', 'weekly', 'manual', 'every_n_months'));

ALTER TABLE public.statement_schedule_configs
  DROP CONSTRAINT IF EXISTS statement_schedule_configs_interval_months_check;

ALTER TABLE public.statement_schedule_configs
  ADD CONSTRAINT statement_schedule_configs_interval_months_check
  CHECK (
    interval_months IS NULL
    OR (interval_months >= 1 AND interval_months <= 36)
  );

COMMENT ON COLUMN public.statement_schedule_configs.interval_months IS
  'When frequency=every_n_months, number of months per reporting period (1–36).';
