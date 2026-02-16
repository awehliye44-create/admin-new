-- Allow admins to insert driver service areas
CREATE POLICY "Admins can insert driver service areas"
ON public.driver_service_areas
FOR INSERT
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- Allow admins to delete driver service areas
CREATE POLICY "Admins can delete driver service areas"
ON public.driver_service_areas
FOR DELETE
USING (public.has_role(auth.uid(), 'admin'::app_role));

-- Allow admins to update driver service areas
CREATE POLICY "Admins can update driver service areas"
ON public.driver_service_areas
FOR UPDATE
USING (public.has_role(auth.uid(), 'admin'::app_role));
