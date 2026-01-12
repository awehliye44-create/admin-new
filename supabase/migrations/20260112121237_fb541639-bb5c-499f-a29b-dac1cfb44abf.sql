-- Add admin policies for regions management
CREATE POLICY "Admins can insert regions"
ON public.regions
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update regions"
ON public.regions
FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete regions"
ON public.regions
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- Add admin policies for service_areas management
CREATE POLICY "Admins can insert service areas"
ON public.service_areas
FOR INSERT
TO authenticated
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update service areas"
ON public.service_areas
FOR UPDATE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can delete service areas"
ON public.service_areas
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));