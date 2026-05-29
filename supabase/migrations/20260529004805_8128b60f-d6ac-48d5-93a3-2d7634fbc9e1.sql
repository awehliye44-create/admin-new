DROP POLICY IF EXISTS "Authenticated users can read dispatch settings" ON public.dispatch_settings;
DROP POLICY IF EXISTS "Public can read dispatch settings" ON public.dispatch_settings;
CREATE POLICY "Admins can read dispatch settings" ON public.dispatch_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated users can read fare pricing settings" ON public.fare_pricing_settings;
CREATE POLICY "Admins can read fare pricing settings" ON public.fare_pricing_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated read service area pricing settings" ON public.service_area_pricing_settings;
CREATE POLICY "Admins read service area pricing settings" ON public.service_area_pricing_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated can read vehicle pricing" ON public.service_area_vehicle_pricing;
CREATE POLICY "Admins can read vehicle pricing" ON public.service_area_vehicle_pricing FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated users can read stop waiting settings" ON public.stop_waiting_settings;
CREATE POLICY "Admins can read stop waiting settings" ON public.stop_waiting_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated users can view templates" ON public.invoice_templates;
CREATE POLICY "Admins can view invoice templates" ON public.invoice_templates FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated users can read notification settings" ON public.notification_settings;
CREATE POLICY "Admins can read notification settings" ON public.notification_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Role permissions viewable by authenticated" ON public.role_page_permissions;
CREATE POLICY "Staff can read their own role permissions" ON public.role_page_permissions FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = auth.uid() AND ur.role::text = role_page_permissions.role::text)
  );

DROP POLICY IF EXISTS "Staff ID sequences viewable by authenticated" ON public.staff_id_sequences;
CREATE POLICY "Admins can read staff id sequences" ON public.staff_id_sequences FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Staff service areas viewable by authenticated" ON public.staff_service_areas;
CREATE POLICY "Admins can read staff service areas" ON public.staff_service_areas FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Authenticated can read enabled preset offer configs" ON public.preset_offer_configs;
CREATE POLICY "Authenticated can read enabled preset offer configs" ON public.preset_offer_configs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role) OR is_enabled = true);