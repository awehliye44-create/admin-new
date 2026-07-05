
-- 1. Fix SUPA_security_definer_view: force security_invoker on the two flagged views
ALTER VIEW public.driver_payout_accounts SET (security_invoker = on);
ALTER VIEW public.driver_payout_destination_audit_logs SET (security_invoker = on);

-- 2. Fix SUPA_function_search_path_mutable: pin search_path
ALTER FUNCTION public.sync_service_area_payment_provider() SET search_path = public;
ALTER FUNCTION public.compute_dispatch_score(dispatch_settings, numeric, numeric, numeric, numeric) SET search_path = public;
ALTER FUNCTION public.compute_dispatch_score(dispatch_settings, double precision, numeric, numeric, numeric) SET search_path = public;

-- 3. Fix SUPA_rls_policy_always_true on campaign_heads_up_templates / campaigns
DROP POLICY IF EXISTS "Staff manage campaign templates" ON public.campaign_heads_up_templates;
CREATE POLICY "Admin or staff manage campaign templates"
  ON public.campaign_heads_up_templates
  FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true)
  );

DROP POLICY IF EXISTS "Staff manage campaigns" ON public.campaign_heads_up_campaigns;
CREATE POLICY "Admin or staff manage campaigns"
  ON public.campaign_heads_up_campaigns
  FOR ALL
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true)
  );

-- 3b. orphan_payments policy currently applies to role "public" with USING/CHECK true.
--     Scope it to the service_role only.
DROP POLICY IF EXISTS "Service role manages orphan_payments" ON public.orphan_payments;
CREATE POLICY "Service role manages orphan_payments"
  ON public.orphan_payments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 4. call_masking_provider_configs_broad_read — drop the authenticated USING(true) SELECT policy.
--    Admins still have full ALL access via the existing management policy.
DROP POLICY IF EXISTS "Call masking provider configs readable by authenticated" ON public.call_masking_provider_configs;

-- 5. trips_pending_broad_driver_visibility — remove the blanket status-based read.
--    Drivers keep: "Drivers can view offered trips" (via dispatch offer),
--    "Drivers can view assigned trips" (own trips), and admin/service policies.
DROP POLICY IF EXISTS "Drivers can view pending trips in their area" ON public.trips;

-- 6. drivers_full_row_exposed_to_passengers — remove full-row passenger SELECT
--    on drivers, replace with a limited-column view.
DROP POLICY IF EXISTS "Passengers can view driver for their trips" ON public.drivers;

CREATE OR REPLACE VIEW public.driver_passenger_profile
WITH (security_invoker = off, security_barrier = true) AS
SELECT
  d.id,
  d.first_name,
  d.last_name,
  d.profile_photo_url,
  d.rating,
  d.display_rating,
  d.rating_count,
  d.total_trips,
  d.is_pet_friendly,
  d.current_lat,
  d.current_lng,
  d.heading,
  d.speed,
  d.last_location_updated_at
FROM public.drivers d
WHERE public.can_passenger_view_driver(d.id);

REVOKE ALL ON public.driver_passenger_profile FROM PUBLIC;
GRANT SELECT ON public.driver_passenger_profile TO authenticated;

COMMENT ON VIEW public.driver_passenger_profile IS
  'Passenger-safe subset of drivers (name, photo, rating, live location for trip). Sensitive PII (email, phone, address, stripe_account_id, driver_code, documents, financial fields) intentionally excluded. Passenger apps must read from this view instead of public.drivers.';
