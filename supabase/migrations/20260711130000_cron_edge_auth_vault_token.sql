-- pg_cron → Edge auth: resolve Bearer from Vault when GUCs are unset.
-- Supabase managed Postgres disallows ALTER DATABASE SET for service_role_key.
-- Ops: ensure vault secret name = 'service_role_key' (or 'supabase_service_role_key').

BEGIN;

CREATE OR REPLACE FUNCTION public.cron_edge_auth_token()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT coalesce(
    nullif(trim(current_setting('app.settings.service_role_key', true)), ''),
    nullif(trim(current_setting('supabase.service_role_key', true)), ''),
    (
      SELECT nullif(trim(ds.decrypted_secret), '')
      FROM vault.decrypted_secrets ds
      WHERE ds.name IN ('service_role_key', 'supabase_service_role_key')
      ORDER BY CASE ds.name WHEN 'service_role_key' THEN 0 ELSE 1 END
      LIMIT 1
    ),
    nullif(trim(current_setting('app.settings.supabase_anon_key', true)), ''),
    nullif(trim(current_setting('SUPABASE_ANON_KEY', true)), '')
  );
$$;

COMMENT ON FUNCTION public.cron_edge_auth_token() IS
  'Resolves Bearer token for pg_cron net.http_post → Edge. Prefer GUC service_role, then vault.service_role_key.';

GRANT EXECUTE ON FUNCTION public.cron_edge_auth_token() TO service_role;

COMMIT;
