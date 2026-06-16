
-- 1. Security definer view fix
ALTER VIEW public.admin_trip_lifecycle_fees SET (security_invoker = on);

-- 2. Enable RLS on remaining public tables (service-role-only — no policies = denied to anon/authenticated)
ALTER TABLE public.trip_invoice_daily_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_invoice_monthly_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_authorization_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_invoice_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.trip_invoice_daily_sequences FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.driver_invoice_monthly_sequences FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.payment_authorization_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON public.trip_invoice_events FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Function search_path hardening
ALTER FUNCTION public.touch_otp_allowed_countries_updated_at() SET search_path = public;
ALTER FUNCTION public.payout_batch_kind_to_ledger_type(text) SET search_path = public;
ALTER FUNCTION public.booking_delivery_phase_is_idempotent(text) SET search_path = public;
ALTER FUNCTION public.trip_negotiation_base_fare_pence(public.trips) SET search_path = public;
ALTER FUNCTION public.compute_dispatch_score(public.dispatch_settings, double precision, numeric, numeric, numeric) SET search_path = public;
ALTER FUNCTION public.set_payment_provider_updated_at() SET search_path = public;

-- 4. payout_audit_log admin SELECT
CREATE POLICY "Admins can read payout audit log"
ON public.payout_audit_log
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- 5. Storage policies for private buckets
-- driver-invoices: object path is "<driver_id>/..."
CREATE POLICY "Drivers can read own invoices"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'driver-invoices'
  AND (storage.foldername(name))[1] IN (
    SELECT d.id::text FROM public.drivers d WHERE d.user_id = auth.uid()
  )
);

CREATE POLICY "Admins manage driver invoices"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'driver-invoices' AND has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (bucket_id = 'driver-invoices' AND has_role(auth.uid(), 'admin'::app_role));

-- trip-invoices: object path is "<trip_id>/..."
CREATE POLICY "Customers can read own trip invoices"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'trip-invoices'
  AND (storage.foldername(name))[1]::uuid IN (
    SELECT t.id FROM public.trips t
    JOIN public.customers c ON c.id = t.passenger_id
    WHERE c.user_id = auth.uid()
  )
);

CREATE POLICY "Drivers can read assigned trip invoices"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'trip-invoices'
  AND (storage.foldername(name))[1]::uuid IN (
    SELECT t.id FROM public.trips t
    WHERE t.driver_id = current_driver_profile_id()
  )
);

CREATE POLICY "Admins manage trip invoices"
ON storage.objects FOR ALL TO authenticated
USING (bucket_id = 'trip-invoices' AND has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (bucket_id = 'trip-invoices' AND has_role(auth.uid(), 'admin'::app_role));

-- 6. Lock down payment_provider_vault completely (service role only via bypassrls)
ALTER TABLE public.payment_provider_vault FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_provider_vault FROM anon, authenticated;

-- 7. Remove admin_settings from realtime broadcast
ALTER PUBLICATION supabase_realtime DROP TABLE public.admin_settings;

-- 8. Tighten trips RLS for drivers
DROP POLICY IF EXISTS "Drivers can view pending trips in their area" ON public.trips;
DROP POLICY IF EXISTS "Drivers can view pending unassigned trips" ON public.trips;
DROP POLICY IF EXISTS "Drivers can accept pending trips" ON public.trips;

-- Drivers may only accept a trip they have been offered
CREATE POLICY "Drivers can accept offered trips"
ON public.trips
FOR UPDATE
TO authenticated
USING (
  (status = ANY (ARRAY['pending'::text, 'searching'::text, 'offered'::text]))
  AND public.driver_can_view_trip_via_offer(id)
)
WITH CHECK (driver_id = public.current_driver_profile_id());
