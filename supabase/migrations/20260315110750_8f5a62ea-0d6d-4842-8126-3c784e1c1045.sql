-- Replace the open read policy with one that shows only active types to non-admins
DROP POLICY "Anyone can read vehicle types" ON public.vehicle_types;

CREATE POLICY "Read vehicle types" ON public.vehicle_types
  FOR SELECT
  USING (
    is_active = true
    OR has_role(auth.uid(), 'admin'::app_role)
  );