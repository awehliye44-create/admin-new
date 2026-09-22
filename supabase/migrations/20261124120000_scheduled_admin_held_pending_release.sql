-- Admin HELD pending release actions (Assign At / Broadcast At).
-- One pending action per trip = single column set (replace/cancel before execute).

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS pending_release_kind text NULL,
  ADD COLUMN IF NOT EXISTS pending_release_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS pending_release_driver_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trips_pending_release_kind_check'
  ) THEN
    ALTER TABLE public.trips
      ADD CONSTRAINT trips_pending_release_kind_check
      CHECK (
        pending_release_kind IS NULL
        OR pending_release_kind IN ('assign', 'broadcast')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.trips.pending_release_kind IS
  'Admin scheduled release: assign | broadcast. Null = no pending action.';
COMMENT ON COLUMN public.trips.pending_release_at IS
  'When pending_release_kind should execute (backend cron — not browser timers).';
COMMENT ON COLUMN public.trips.pending_release_driver_id IS
  'Target driver for pending assign release.';

CREATE INDEX IF NOT EXISTS trips_pending_release_due_idx
  ON public.trips (pending_release_at)
  WHERE pending_release_kind IS NOT NULL AND pending_release_at IS NOT NULL;
