-- Demand zone audit log: gate reads on demand_zones.view_audit (not legacy admin role only).

DROP POLICY IF EXISTS "Admins read demand zone audit log" ON public.demand_zone_audit_log;

CREATE POLICY "Staff with view_audit read demand zone audit log"
  ON public.demand_zone_audit_log
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin(auth.uid())
    OR public.staff_has_action(auth.uid(), 'demand_zones.view_audit')
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
  );
