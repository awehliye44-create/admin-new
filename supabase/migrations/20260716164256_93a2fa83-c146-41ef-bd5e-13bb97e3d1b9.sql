
DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE OR REPLACE FUNCTION public.admin_get_user_email(_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT email::text FROM auth.users WHERE id = _user_id
    AND (public.has_role(auth.uid(), 'admin') OR auth.role() = 'service_role');
$$;

REVOKE ALL ON FUNCTION public.admin_get_user_email(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_user_email(uuid) TO authenticated, service_role;

CREATE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = on) AS
SELECT c.id,
    c.user_id,
    c.customer_code,
    c.first_name,
    c.last_name,
    c.phone,
    public.admin_get_user_email(c.user_id) AS email,
    c.created_at,
    c.updated_at,
    c.rider_status,
    COALESCE(ts.trip_count, 0) AS trip_count,
    ts.last_trip_at
FROM customers c
LEFT JOIN (
    SELECT t.passenger_id,
           count(*)::integer AS trip_count,
           max(t.created_at) AS last_trip_at
      FROM trips t
     WHERE t.passenger_id IS NOT NULL
     GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL
  AND c.rider_status = 'active'
  AND c.email_verified IS TRUE
  AND c.phone_verified IS TRUE;

GRANT SELECT ON public.admin_riders_with_trip_stats TO authenticated, service_role;
