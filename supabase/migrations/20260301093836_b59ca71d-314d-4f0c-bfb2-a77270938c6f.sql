-- Add pickup and dropoff fee columns to zone_route_pricing
ALTER TABLE public.zone_route_pricing
  ADD COLUMN IF NOT EXISTS pickup_fee numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dropoff_fee numeric NOT NULL DEFAULT 0;

-- Drop and recreate the ALL policy to use 'to authenticated' explicitly
DROP POLICY IF EXISTS "Admins can manage zone route pricing" ON public.zone_route_pricing;
CREATE POLICY "Admins can manage zone route pricing"
  ON public.zone_route_pricing
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));