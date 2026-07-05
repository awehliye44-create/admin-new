-- See onecab-comfy-ride/supabase/migrations/20260706123000_call_masking_provider_configs_admin_read.sql
-- (applied to prod via linked query)

DROP POLICY IF EXISTS "Call masking provider configs readable by authenticated"
  ON public.call_masking_provider_configs;

CREATE POLICY "Call masking provider configs readable by authenticated"
  ON public.call_masking_provider_configs
  FOR SELECT
  TO authenticated
  USING (true);
