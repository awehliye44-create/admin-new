-- Demand zones admin RBAC: page seed + table policies aligned with action keys.

INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'driver-demand-zones', true),
  ('admin', 'driver-demand-zones', true),
  ('operator', 'driver-demand-zones', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;

ALTER TABLE public.driver_demand_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view active demand zones" ON public.driver_demand_zones;
DROP POLICY IF EXISTS "Staff view demand zones" ON public.driver_demand_zones;
DROP POLICY IF EXISTS "Staff manage manual demand zones insert" ON public.driver_demand_zones;
DROP POLICY IF EXISTS "Staff manage manual demand zones update" ON public.driver_demand_zones;
DROP POLICY IF EXISTS "Staff manage manual demand zones delete" ON public.driver_demand_zones;

CREATE POLICY "Staff view demand zones"
  ON public.driver_demand_zones
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.staff_has_action(auth.uid(), 'demand_zones.view')
  );

CREATE POLICY "Staff manage manual demand zones insert"
  ON public.driver_demand_zones
  FOR INSERT TO authenticated
  WITH CHECK (
    source = 'manual'
    AND (
      public.is_super_admin(auth.uid())
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.staff_has_action(auth.uid(), 'demand_zones.configure_heatmap')
    )
  );

CREATE POLICY "Staff manage manual demand zones update"
  ON public.driver_demand_zones
  FOR UPDATE TO authenticated
  USING (
    source = 'manual'
    AND (
      public.is_super_admin(auth.uid())
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.staff_has_action(auth.uid(), 'demand_zones.configure_heatmap')
    )
  )
  WITH CHECK (
    source = 'manual'
    AND (
      public.is_super_admin(auth.uid())
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.staff_has_action(auth.uid(), 'demand_zones.configure_heatmap')
    )
  );

CREATE POLICY "Staff manage manual demand zones delete"
  ON public.driver_demand_zones
  FOR DELETE TO authenticated
  USING (
    source = 'manual'
    AND (
      public.is_super_admin(auth.uid())
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.staff_has_action(auth.uid(), 'demand_zones.configure_heatmap')
    )
  );

DROP POLICY IF EXISTS "Admins read demand zone settings" ON public.service_area_demand_zone_settings;

CREATE POLICY "Staff read demand zone settings"
  ON public.service_area_demand_zone_settings
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.staff_has_action(auth.uid(), 'demand_zones.view')
    OR public.staff_has_action(auth.uid(), 'demand_zones.configure_heatmap')
    OR public.staff_has_action(auth.uid(), 'demand_zones.configure_colours')
    OR public.staff_has_action(auth.uid(), 'demand_zones.configure_surge')
  );
