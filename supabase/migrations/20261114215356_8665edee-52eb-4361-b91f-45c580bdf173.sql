REVOKE ALL ON public.customer_live_trip_settings FROM anon;
REVOKE ALL ON public.customer_live_trip_settings FROM authenticated;
GRANT SELECT ON public.customer_live_trip_settings TO authenticated;
GRANT ALL ON public.customer_live_trip_settings TO service_role;

ALTER TABLE public.customer_live_trip_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view customer live trip settings" ON public.customer_live_trip_settings;
CREATE POLICY "Admins can view customer live trip settings"
ON public.customer_live_trip_settings
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role));