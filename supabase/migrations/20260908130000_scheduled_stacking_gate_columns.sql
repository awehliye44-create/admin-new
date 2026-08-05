-- Ensure stacking gate columns exist on global_dispatch_settings (idempotent).
-- Admin already persists these flags; SQL/Edge consumers must be able to read them.
-- Commitment policy columns remain owned by 20260908120000_scheduled_rides_commitment_policy.sql.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS allow_airport_stacking boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_scheduled_stacking boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_stacking_during_pickup_waiting boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_stacking_during_stop_waiting boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.global_dispatch_settings.allow_scheduled_stacking IS
  'When true, stacking before scheduled commitments is allowed only if full-queue feasibility proves no scheduled pickup is delayed. Never bypasses commitment protection.';

COMMENT ON COLUMN public.global_dispatch_settings.allow_airport_stacking IS
  'Permit stacked offers on airport trips. Never bypasses scheduled commitment protection.';

COMMENT ON COLUMN public.global_dispatch_settings.allow_stacking_during_pickup_waiting IS
  'Permit stacking while driver waits at pickup. Never bypasses scheduled commitment protection.';

COMMENT ON COLUMN public.global_dispatch_settings.allow_stacking_during_stop_waiting IS
  'Permit stacking during multi-stop paid waiting. Never bypasses scheduled commitment protection.';
