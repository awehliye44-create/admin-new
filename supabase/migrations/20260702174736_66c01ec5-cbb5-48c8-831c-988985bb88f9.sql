
-- 1. Enable RLS on financial SSOT tables (admin/service-role only)
ALTER TABLE public.financial_ssot_mismatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_ssot_repairs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can read ssot mismatches"
  ON public.financial_ssot_mismatches
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can read ssot repairs"
  ON public.financial_ssot_repairs
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- No INSERT/UPDATE/DELETE policies: only service_role (bypasses RLS) may write.

-- 2. Create service-role-only integration secret vault
CREATE TABLE IF NOT EXISTS public.integration_secret_vault (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace text NOT NULL,             -- e.g. 'integration' or 'webhook'
  owner_id text NOT NULL,              -- id of the integration/webhook
  secret_name text NOT NULL,           -- e.g. 'api_key','api_secret','webhook_secret'
  secret_value text NOT NULL,
  masked_preview text NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, owner_id, secret_name)
);

REVOKE ALL ON public.integration_secret_vault FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.integration_secret_vault TO service_role;
ALTER TABLE public.integration_secret_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_secret_vault FORCE ROW LEVEL SECURITY;
-- No policies: default-deny for everyone except service_role bypass.
