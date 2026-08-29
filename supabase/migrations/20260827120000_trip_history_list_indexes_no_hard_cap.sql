-- Admin Trip History / finance list filters: indexes instead of hard-capping history.
-- Trips remain stored permanently; these only speed paginated + filtered reads.

CREATE INDEX IF NOT EXISTS idx_trips_sa_completed_id
  ON public.trips (service_area_id, completed_at DESC, id)
  WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_driver_completed_id
  ON public.trips (driver_id, completed_at DESC, id)
  WHERE driver_id IS NOT NULL AND completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_passenger_completed_id
  ON public.trips (passenger_id, completed_at DESC, id)
  WHERE passenger_id IS NOT NULL AND completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trips_status_created_id
  ON public.trips (status, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_trips_financial_outcome_completed
  ON public.trips (financial_outcome, completed_at DESC, id)
  WHERE completed_at IS NOT NULL;
