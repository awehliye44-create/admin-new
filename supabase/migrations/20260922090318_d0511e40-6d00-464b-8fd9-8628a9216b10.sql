CREATE TABLE public.driver_internal_profiles (
  driver_id UUID PRIMARY KEY REFERENCES public.drivers(id) ON DELETE CASCADE,
  council_licence_authority TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_internal_profiles TO authenticated;
GRANT ALL ON public.driver_internal_profiles TO service_role;

ALTER TABLE public.driver_internal_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage driver internal profiles"
ON public.driver_internal_profiles
FOR ALL
TO authenticated
USING (public.has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role manages driver internal profiles"
ON public.driver_internal_profiles
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE TRIGGER update_driver_internal_profiles_updated_at
BEFORE UPDATE ON public.driver_internal_profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();