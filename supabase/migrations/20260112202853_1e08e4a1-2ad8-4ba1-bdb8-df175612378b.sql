-- Add admin policies for driver_vehicle_categories table
-- Admins should be able to manage all driver vehicle categories

CREATE POLICY "Admins can read all driver vehicle categories"
ON public.driver_vehicle_categories
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can insert driver vehicle categories"
ON public.driver_vehicle_categories
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update driver vehicle categories"
ON public.driver_vehicle_categories
FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete driver vehicle categories"
ON public.driver_vehicle_categories
FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));