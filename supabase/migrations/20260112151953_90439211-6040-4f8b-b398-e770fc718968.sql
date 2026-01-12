-- Add admin policies for trips table
-- Allow admins to read all trips
CREATE POLICY "Admins can read all trips"
ON public.trips
FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Allow admins to update all trips (for cancellation, reassignment, etc.)
CREATE POLICY "Admins can update all trips"
ON public.trips
FOR UPDATE
USING (has_role(auth.uid(), 'admin'::app_role));

-- Allow admins to insert trips (for manual trip creation)
CREATE POLICY "Admins can insert trips"
ON public.trips
FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Allow admins to delete trips if needed
CREATE POLICY "Admins can delete trips"
ON public.trips
FOR DELETE
USING (has_role(auth.uid(), 'admin'::app_role));