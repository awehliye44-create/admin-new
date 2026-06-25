
-- 1) customers: remove redundant {public}-role policies, keep authenticated-scoped equivalents
DROP POLICY IF EXISTS "Users can view their own customer record" ON public.customers;
DROP POLICY IF EXISTS "Users can update their own customer record" ON public.customers;

-- 2) driver_live_locations: allow a driver to SELECT their own live location row
CREATE POLICY "Drivers can view their own live location"
ON public.driver_live_locations
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.drivers d
    WHERE d.id = driver_live_locations.driver_id
      AND d.user_id = auth.uid()
  )
);

-- 3) trip_route_cache: zero-policy deny-all is intentional (service_role only via edge functions)
COMMENT ON TABLE public.trip_route_cache IS
'Server-only cache. RLS is fail-closed by design: all reads/writes occur via edge functions using the service role. Do not add anon/authenticated policies without explicit security review.';
