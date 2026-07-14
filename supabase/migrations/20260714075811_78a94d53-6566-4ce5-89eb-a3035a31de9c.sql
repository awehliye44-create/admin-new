
-- Fix call masking config broad read access
DROP POLICY IF EXISTS "Call masking provider configs readable by authenticated" ON public.call_masking_provider_configs;
CREATE POLICY "Call masking provider configs readable by staff"
  ON public.call_masking_provider_configs FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true));

DROP POLICY IF EXISTS "Service area call masking config readable by authenticated" ON public.service_area_call_masking_config;
CREATE POLICY "Service area call masking config readable by staff"
  ON public.service_area_call_masking_config FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true));

DROP POLICY IF EXISTS "Service area communication settings readable by authenticated" ON public.service_area_communication_settings;
CREATE POLICY "Service area communication settings readable by staff"
  ON public.service_area_communication_settings FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true));

-- Fix campaign heads up campaigns broad read access
DROP POLICY IF EXISTS "Staff read campaigns" ON public.campaign_heads_up_campaigns;
CREATE POLICY "Staff read campaigns"
  ON public.campaign_heads_up_campaigns FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active = true));

-- Fix RLS policy always true (public role - applies to anon/authenticated)
DROP POLICY IF EXISTS "Service role manages payment_session_authorisations" ON public.payment_session_authorisations;
CREATE POLICY "Service role manages payment_session_authorisations"
  ON public.payment_session_authorisations FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manages payment_session_refunds" ON public.payment_session_refunds;
CREATE POLICY "Service role manages payment_session_refunds"
  ON public.payment_session_refunds FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Fix mutable search_path on functions
ALTER FUNCTION public.bump_service_area_communication_version() SET search_path = public;
ALTER FUNCTION public.prevent_driver_wallet_ledger_delete() SET search_path = public;
