-- Fix overly permissive RLS policy on id_sequences
-- This table should only be accessed by SECURITY DEFINER functions (triggers)
DROP POLICY IF EXISTS "System can manage sequences" ON public.id_sequences;

-- No direct access policies - only triggers with SECURITY DEFINER can access
-- Add a restrictive policy that blocks all direct access
CREATE POLICY "No direct access to sequences" ON public.id_sequences 
  FOR ALL 
  USING (false);