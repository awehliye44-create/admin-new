-- Rollback tip window deferral columns (additive reverse).

DROP INDEX IF EXISTS public.idx_trips_tip_window_expiry_open;

ALTER TABLE public.trips
  DROP COLUMN IF EXISTS tip_window_opened_at,
  DROP COLUMN IF EXISTS tip_window_status;
