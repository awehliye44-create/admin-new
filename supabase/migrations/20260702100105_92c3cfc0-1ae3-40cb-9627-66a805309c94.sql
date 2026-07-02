
-- 1. SUPA_auth_users_exposed + SUPA_security_definer_view: harden the two views
ALTER VIEW public.admin_pending_customer_signups SET (security_invoker = on);
ALTER VIEW public.admin_customer_code_audit SET (security_invoker = on);
REVOKE ALL ON public.admin_pending_customer_signups FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.admin_customer_code_audit FROM anon, authenticated, PUBLIC;
GRANT SELECT ON public.admin_pending_customer_signups TO service_role;
GRANT SELECT ON public.admin_customer_code_audit TO service_role;

-- 2. SUPA_function_search_path_mutable: pin search_path
ALTER FUNCTION public.is_email_pending_active(text, timestamptz, timestamptz, timestamptz) SET search_path = public;
ALTER FUNCTION public.is_phone_pending_active(text, timestamptz, timestamptz, timestamptz) SET search_path = public;
ALTER FUNCTION public.is_trip_commitment_monitoring_active(uuid) SET search_path = public;
ALTER FUNCTION public.normalize_phone_digits(text) SET search_path = public;
ALTER FUNCTION public.prevent_direct_driver_email_update() SET search_path = public;

-- 3. trip_messages_missing_delete_policy: admin moderation coverage
DROP POLICY IF EXISTS "Admins can moderate trip messages" ON public.trip_messages;
CREATE POLICY "Admins can moderate trip messages"
  ON public.trip_messages
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 4. trip_stops_passenger_id_mismatch: replace broken policy with correct customer join
DROP POLICY IF EXISTS "Passengers can view their trip stops" ON public.trip_stops;
CREATE POLICY "Passengers can view their trip stops"
  ON public.trip_stops
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.trips t
      JOIN public.customers c ON c.id = t.passenger_id
      WHERE t.id = trip_stops.trip_id
        AND c.user_id = auth.uid()
    )
  );

-- 5. Restrict broad SELECT on internal config tables to admins only
--    (runtime apps read these via edge functions using service role)
DROP POLICY IF EXISTS "Authenticated users can read fare pricing settings" ON public.fare_pricing_settings;
DROP POLICY IF EXISTS "Authenticated users can read service area vehicle types" ON public.service_area_vehicle_types;
DROP POLICY IF EXISTS "Anyone can read service area cancellation fees" ON public.service_area_cancellation_fees;
DROP POLICY IF EXISTS "Anyone can read region payment methods" ON public.region_payment_methods;
DROP POLICY IF EXISTS "Authenticated users can view active demand zones" ON public.driver_demand_zones;
DROP POLICY IF EXISTS "Authenticated users can read active zone route pricing" ON public.zone_route_pricing;
