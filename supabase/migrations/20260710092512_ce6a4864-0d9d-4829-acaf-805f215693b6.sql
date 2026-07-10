
-- 1) Fix SECURITY DEFINER view: driver_payout_accounts -> security_invoker
ALTER VIEW public.driver_payout_accounts SET (security_invoker = on, security_barrier = true);

-- 2) Fix RLS Policy Always True: payment_sessions policy applied to PUBLIC role
DROP POLICY IF EXISTS "Service role manages payment_sessions" ON public.payment_sessions;
CREATE POLICY "Service role manages payment_sessions"
  ON public.payment_sessions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3) Restrict driver PII exposure to passengers/corporate users.
-- Drop overly broad SELECT policies that exposed the entire drivers row.
DROP POLICY IF EXISTS "Passengers can view driver for their trips" ON public.drivers;
DROP POLICY IF EXISTS "Corporate users can view drivers on their trips" ON public.drivers;

-- Create a narrow, safe view for passenger + corporate consumers.
CREATE OR REPLACE VIEW public.drivers_public_safe
WITH (security_invoker = on, security_barrier = true) AS
SELECT
  d.id,
  d.first_name,
  d.profile_photo_url,
  d.display_rating,
  d.rating,
  d.total_trips,
  d.driver_code,
  d.category_id,
  d.service_area_id,
  d.region_id,
  d.is_online,
  d.current_lat,
  d.current_lng,
  d.heading,
  d.speed,
  d.last_location_updated_at,
  d.current_trip_id
FROM public.drivers d
WHERE
  public.can_passenger_view_driver(d.id)
  OR public.can_corporate_user_view_driver(d.id, auth.uid());

REVOKE ALL ON public.drivers_public_safe FROM PUBLIC;
GRANT SELECT ON public.drivers_public_safe TO authenticated;
