DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;
CREATE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = on) AS
SELECT c.id,
    c.user_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    c.phone,
    u.email,
    c.created_at,
    c.updated_at,
    c.rider_status,
    COALESCE(ts.trip_count, 0) AS trip_count,
    ts.last_trip_at
   FROM public.customers c
     LEFT JOIN auth.users u ON u.id = c.user_id
     LEFT JOIN ( SELECT t.passenger_id,
            count(*)::integer AS trip_count,
            max(t.created_at) AS last_trip_at
           FROM public.trips t
          WHERE t.passenger_id IS NOT NULL
          GROUP BY t.passenger_id) ts ON ts.passenger_id = c.id
  WHERE c.deleted_at IS NULL AND c.rider_status = 'active'::text AND c.email_verified IS TRUE AND c.phone_verified IS TRUE;
GRANT SELECT ON public.admin_riders_with_trip_stats TO authenticated;
GRANT ALL ON public.admin_riders_with_trip_stats TO service_role;