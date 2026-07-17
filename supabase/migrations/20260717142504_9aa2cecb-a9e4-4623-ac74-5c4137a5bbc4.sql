DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = on) AS
SELECT
  c.id,
  c.user_id,
  c.customer_code,
  c.first_name,
  c.last_name,
  c.phone,
  public.admin_get_user_email(c.user_id) AS email,
  c.created_at,
  c.updated_at,
  c.rider_status,
  c.email_verified,
  c.phone_verified,
  COALESCE(ts.trip_count, 0) AS trip_count,
  ts.last_trip_at
FROM public.customers c
LEFT JOIN (
  SELECT t.passenger_id,
         count(*)::integer AS trip_count,
         max(t.created_at) AS last_trip_at
  FROM public.trips t
  WHERE t.passenger_id IS NOT NULL
  GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL;

GRANT SELECT ON public.admin_riders_with_trip_stats TO authenticated;
GRANT ALL ON public.admin_riders_with_trip_stats TO service_role;