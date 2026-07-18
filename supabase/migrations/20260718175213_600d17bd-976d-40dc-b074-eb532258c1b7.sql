
-- Fix service_areas_anon_full_read: remove USING(true) policy exposing financial config to anon
DROP POLICY IF EXISTS v2_driver_select_service_areas ON public.service_areas;

CREATE POLICY v2_driver_select_service_areas
  ON public.service_areas
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Fix regions_anon_full_read: remove unrestricted USING(true), keep active-only scope
DROP POLICY IF EXISTS v2_driver_select_regions ON public.regions;

CREATE POLICY v2_driver_select_regions
  ON public.regions
  FOR SELECT
  TO authenticated
  USING (status = 'active');

-- Fix commission_wallet_campaigns_broad_read: scope to active campaigns for the driver's own service area
DROP POLICY IF EXISTS commission_wallet_campaigns_auth_read ON public.commission_wallet_campaigns;

CREATE POLICY commission_wallet_campaigns_auth_read
  ON public.commission_wallet_campaigns
  FOR SELECT
  TO authenticated
  USING (
    active = true
    AND EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.user_id = auth.uid()
        AND d.service_area_id = commission_wallet_campaigns.service_area_id
    )
  );
