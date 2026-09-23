-- Allow Admin "Make Available in Scheduled Jobs At" via pending_release_kind.
-- Assign At / Broadcast At already use assign | broadcast.
-- Jobs At publishes Scheduled Jobs only (not NRO) when due.

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_pending_release_kind_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_pending_release_kind_check
  CHECK (
    pending_release_kind IS NULL
    OR pending_release_kind IN ('assign', 'broadcast', 'jobs')
  );

COMMENT ON COLUMN public.trips.pending_release_kind IS
  'Admin scheduled release: assign | broadcast | jobs. Null = no pending action. jobs = Make Available in Scheduled Jobs At.';
