-- Grant table privileges on merchants so PostgREST/edge function service role can read & write.
-- RLS still governs row visibility for anon/authenticated.
GRANT SELECT ON public.merchants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchants TO authenticated;
GRANT ALL ON public.merchants TO service_role;