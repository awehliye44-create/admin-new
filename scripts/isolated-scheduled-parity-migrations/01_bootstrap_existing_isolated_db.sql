-- Bootstrap columns/helpers missing from local isolated Supabase (54322)
-- that production already has. Safe / idempotent. Does NOT invent data.
-- Required before applying 20270218130000 / 30100 / 30200.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_hold_reason text;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_publish_attempts integer DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'trips_scheduled_hold_reason_check'
  ) THEN
    ALTER TABLE public.trips
      ADD CONSTRAINT trips_scheduled_hold_reason_check
      CHECK (
        scheduled_hold_reason IS NULL
        OR scheduled_hold_reason = ANY (ARRAY[
          'publication_pending','publication_retry','publication_exhausted',
          'airport_pricing','payment_gate','manual','manual_trip',
          'admin_exceptional','unknown_historical'
        ])
      );
  END IF;
END $$;

ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_deadline timestamptz;
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_deadline_source text;
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_deadline_updated_at timestamptz;
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS capture_deadline_observed_at timestamptz;

CREATE OR REPLACE FUNCTION public.required_capture_coverage_until(
  p_scheduled_at timestamptz,
  p_duration_minutes int DEFAULT 30,
  p_safety_minutes int DEFAULT 360
)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT p_scheduled_at
    + make_interval(mins => COALESCE(p_duration_minutes, 30))
    + make_interval(mins => COALESCE(p_safety_minutes, 360));
$$;

-- Permissions: keep execute for authenticated/service roles if present.
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION public.required_capture_coverage_until(timestamptz, int, int) TO authenticated;
  GRANT EXECUTE ON FUNCTION public.required_capture_coverage_until(timestamptz, int, int) TO service_role;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

-- Local isolated DB may lack this helper; finalize calls it after INSERT.
CREATE OR REPLACE FUNCTION public.ensure_trip_stops_for_assignment(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- no-op fixture helper for isolated verification
  NULL;
END;
$$;
