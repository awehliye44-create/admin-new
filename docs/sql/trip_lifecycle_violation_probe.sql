-- READ-ONLY production violation probe for trip lifecycle invariants.
-- Run with service role / linked SQL. Do NOT add CHECKs until rows are audited.
-- Matches assertTripLifecycleInvariants in tripLifecycleTransitionMatrix.ts.

-- 1) completed with active dispatch
SELECT 'completed_with_active_dispatch' AS violation, id, status, dispatch_status, driver_id, confirmed_driver_id
FROM public.trips
WHERE status IN ('completed', 'complete', 'finished')
  AND dispatch_status IS NOT NULL
  AND lower(dispatch_status) NOT IN ('completed', 'cancelled', 'canceled', 'no_show', 'expired', 'settled');

-- 2) cancelled with assigned driver
SELECT 'cancelled_with_assigned_driver' AS violation, id, status, dispatch_status, driver_id, confirmed_driver_id
FROM public.trips
WHERE status IN ('cancelled', 'canceled', 'customer_cancelled', 'driver_cancelled')
  AND (driver_id IS NOT NULL OR confirmed_driver_id IS NOT NULL);

-- 3) no_show with assigned driver
SELECT 'no_show_with_assigned_driver' AS violation, id, status, dispatch_status, driver_id, confirmed_driver_id
FROM public.trips
WHERE status IN ('no_show', 'no-show')
  AND (driver_id IS NOT NULL OR confirmed_driver_id IS NOT NULL);

-- 4) queued and active simultaneously (same driver has queued + non-terminal active)
SELECT 'queued_and_active_simultaneously' AS violation, q.id AS queued_trip_id, a.id AS active_trip_id,
  COALESCE(q.driver_id, q.confirmed_driver_id) AS driver_id
FROM public.trips q
JOIN public.trips a
  ON COALESCE(q.driver_id, q.confirmed_driver_id) = COALESCE(a.driver_id, a.confirmed_driver_id)
 AND q.id <> a.id
WHERE q.status = 'queued'
  AND a.status IS DISTINCT FROM 'queued'
  AND a.status NOT IN (
    'completed', 'cancelled', 'canceled', 'customer_cancelled',
    'driver_cancelled', 'no_show', 'expired', 'declined', 'failed'
  )
  AND COALESCE(q.driver_id, q.confirmed_driver_id) IS NOT NULL;

-- 5) in_progress without assigned driver
SELECT 'in_progress_without_assigned_driver' AS violation, id, status, dispatch_status, driver_id, confirmed_driver_id
FROM public.trips
WHERE status IN ('in_progress', 'started', 'on_trip', 'ongoing')
  AND driver_id IS NULL
  AND confirmed_driver_id IS NULL;

-- 6) completed with pending intermediate stops
SELECT 'completed_with_pending_intermediate_stops' AS violation, t.id, t.status, s.id AS stop_id, s.status AS stop_status
FROM public.trips t
JOIN public.trip_stops s ON s.trip_id = t.id
WHERE t.status IN ('completed', 'complete', 'finished')
  AND coalesce(s.type, '') NOT IN ('pickup', 'dropoff')
  AND lower(coalesce(s.status, '')) IN ('pending', 'current', 'active', 'arrived');

-- 7) active driver pointing to a different trip
SELECT 'active_driver_points_to_different_trip_assignment' AS violation,
  d.id AS driver_id, d.current_trip_id, t.id AS trip_id, t.status, t.driver_id, t.confirmed_driver_id
FROM public.drivers d
JOIN public.trips t ON t.id = d.current_trip_id
WHERE d.current_trip_id IS NOT NULL
  AND t.driver_id IS DISTINCT FROM d.id
  AND t.confirmed_driver_id IS DISTINCT FROM d.id;

-- 8) queued trip occupying current_trip_id
SELECT 'queued_trip_occupying_active_trip_state' AS violation,
  d.id AS driver_id, d.current_trip_id, t.status
FROM public.drivers d
JOIN public.trips t ON t.id = d.current_trip_id
WHERE t.status = 'queued';
