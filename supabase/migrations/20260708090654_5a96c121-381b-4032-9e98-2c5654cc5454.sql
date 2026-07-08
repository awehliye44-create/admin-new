
-- Restrict staff scheduling & HR SELECT policies to admin/staff only
DROP POLICY IF EXISTS "Staff leave exceptions viewable by authenticated" ON public.staff_leave_exceptions;
CREATE POLICY "Staff leave exceptions viewable by admin or staff"
  ON public.staff_leave_exceptions FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active));

DROP POLICY IF EXISTS "Staff work patterns viewable by authenticated" ON public.staff_work_patterns;
CREATE POLICY "Staff work patterns viewable by admin or staff"
  ON public.staff_work_patterns FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active));

DROP POLICY IF EXISTS "Staff pattern assignments viewable by authenticated" ON public.staff_pattern_assignments;
CREATE POLICY "Staff pattern assignments viewable by admin or staff"
  ON public.staff_pattern_assignments FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active));

DROP POLICY IF EXISTS "Staff coverage requirements viewable by authenticated" ON public.staff_coverage_requirements;
CREATE POLICY "Staff coverage requirements viewable by admin or staff"
  ON public.staff_coverage_requirements FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active));

-- Restrict campaign delivery visibility to admin/staff (users still see their own via existing policy)
DROP POLICY IF EXISTS "Staff read all campaign deliveries" ON public.campaign_heads_up_deliveries;
CREATE POLICY "Admin or staff read all campaign deliveries"
  ON public.campaign_heads_up_deliveries FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role) OR EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active));

-- Fix SECURITY DEFINER views (set security_invoker=on so RLS runs as the querying user)
ALTER VIEW public.driver_passenger_profile SET (security_invoker = on);
ALTER VIEW public.driver_payout_accounts SET (security_invoker = on);
