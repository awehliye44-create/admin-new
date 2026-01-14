-- Fix overly permissive INSERT policy for corporate_account_requests
DROP POLICY IF EXISTS "Anyone can submit account requests" ON public.corporate_account_requests;

-- Create more restrictive policy - only authenticated users can submit
CREATE POLICY "Authenticated users can submit account requests"
    ON public.corporate_account_requests FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);