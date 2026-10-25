-- A8B28F tip window deferral columns (additive).
-- tip_window_status: open | closed | null (never opened)

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS tip_window_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS tip_window_status text;

COMMENT ON COLUMN public.trips.tip_window_opened_at IS
  'When the post-completion tip window opened (Customer App card + tips_enabled).';
COMMENT ON COLUMN public.trips.tip_window_status IS
  'Tip window lifecycle: open | closed. Null when no tip window was opened.';

CREATE INDEX IF NOT EXISTS idx_trips_tip_window_expiry_open
  ON public.trips (tip_window_expires_at)
  WHERE tip_window_status = 'open'
    AND tip_window_closed_at IS NULL
    AND status = 'completed';
