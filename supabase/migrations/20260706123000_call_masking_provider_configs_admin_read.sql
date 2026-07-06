-- Communication SSOT admin UI reads call_masking_provider_configs for the provider
-- dropdown. Migration 20260705153230 dropped the authenticated SELECT policy; only
-- the admin FOR ALL policy remained, which left the admin catalog empty in PostgREST.
-- This catalog holds non-secret assignment metadata (pool id, caller id label) — MSG91
-- API keys remain in edge function secrets.

DROP POLICY IF EXISTS "Call masking provider configs readable by authenticated"
  ON public.call_masking_provider_configs;

CREATE POLICY "Call masking provider configs readable by authenticated"
  ON public.call_masking_provider_configs
  FOR SELECT
  TO authenticated
  USING (true);
