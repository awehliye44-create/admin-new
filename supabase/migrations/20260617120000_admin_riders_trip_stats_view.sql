-- Admin Riders list: join customers to trips via customers.id (trips.passenger_id FK).
-- trips.passenger_id stores customers.id, NOT auth.users.id.

CREATE OR REPLACE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = true)
AS
SELECT
  c.id,
  c.user_id,
  c.customer_code,
  c.first_name,
  c.last_name,
  c.phone,
  c.created_at,
  c.updated_at,
  c.rider_status,
  COALESCE(ts.trip_count, 0)::integer AS trip_count,
  ts.last_trip_at
FROM public.customers c
LEFT JOIN (
  SELECT
    t.passenger_id,
    COUNT(*)::integer AS trip_count,
    MAX(t.created_at) AS last_trip_at
  FROM public.trips t
  WHERE t.passenger_id IS NOT NULL
  GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL;

COMMENT ON VIEW public.admin_riders_with_trip_stats IS
  'Admin riders list with trip_count/last_trip_at keyed by customers.id = trips.passenger_id.';

GRANT SELECT ON public.admin_riders_with_trip_stats TO authenticated;
GRANT SELECT ON public.admin_riders_with_trip_stats TO service_role;
