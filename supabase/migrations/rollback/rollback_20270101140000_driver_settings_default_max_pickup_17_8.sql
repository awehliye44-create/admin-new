-- Rollback: restore previous column default of 5.0 miles.
-- Does NOT rewrite driver rows back to prior per-driver values (those were not snapshotted).

ALTER TABLE public.driver_settings
  ALTER COLUMN max_pickup_distance_miles SET DEFAULT 5.0;
