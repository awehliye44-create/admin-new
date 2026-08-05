-- ============================================================================
-- P0 (draft — DO NOT APPLY until explicitly approved):
-- Allow authenticated customers to SELECT location columns for the driver
-- currently assigned to their live trip, so the Customer app can subscribe
-- to drivers Realtime for assigned/active tracking (trip_id + driver_id).
--
-- Location SSOT remains driver_presence → drivers.current_* mirrors
-- (migration 20260910120000). This policy only opens a read path for the
-- passenger on their own assigned driver — it does not add a second writer.
--
-- Without this policy, Customer falls back to restore-active-trip polling
-- (CUSTOMER_ACTIVE_TRIP_TRACKING.restorePollIntervalMs).
-- ============================================================================

-- Narrow SELECT for passengers on the assigned/active driver of their trip.
DROP POLICY IF EXISTS "Passengers can view assigned driver location" ON public.drivers;

CREATE POLICY "Passengers can view assigned driver location"
ON public.drivers
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.trips t
    JOIN public.customers c ON c.id = t.passenger_id
    WHERE c.user_id = auth.uid()
      AND (
        t.driver_id = drivers.id
        OR t.confirmed_driver_id = drivers.id
      )
      AND lower(COALESCE(t.status, '')) IN (
        'accepted',
        'confirmed',
        'driver_assigned',
        'en_route',
        'en_route_to_pickup',
        'enroute_to_pickup',
        'driver_en_route',
        'driver_arriving',
        'arrived',
        'arrived_pickup',
        'arrived_at_pickup',
        'at_pickup',
        'pickup_waiting',
        'waiting',
        'waiting_at_pickup',
        'driver_arrived',
        'in_progress',
        'on_trip',
        'started',
        'arrived_at_stop',
        'drive_to_next_stop',
        'completing'
      )
  )
);

COMMENT ON POLICY "Passengers can view assigned driver location" ON public.drivers IS
  'Customer live-tracking read path for the assigned driver only. Does not grant fleet browsing. Deploy only with explicit approval.';
