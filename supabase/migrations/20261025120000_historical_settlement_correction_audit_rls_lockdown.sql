-- ============================================================
-- Forward: lockdown public.historical_settlement_correction_audit
--
-- Pre-audit (2026-08-25, project thazislrdkjpvvghtvzo):
--   - RLS disabled
--   - anon + authenticated had SELECT/INSERT/UPDATE/DELETE
--   - 2 audit rows; no client UI callers (types.ts only)
--   - advisor: rls_disabled_in_public
--   - advisor WARN: historical_settlement_correction_audit_immutable
--     mutable search_path (proconfig was NULL)
--
-- Intent:
--   Enable RLS, revoke client grants, keep service_role DML,
--   no anon/authenticated policies, fix function search_path.
--   Does NOT modify audit row data or any money tables.
--
-- Rollback file:
--   supabase/migrations/rollback/rollback_20261025120000_historical_settlement_correction_audit_rls_lockdown.sql
-- ============================================================

BEGIN;

-- 1) Enable RLS (deny-by-default for roles that do not bypass RLS)
ALTER TABLE public.historical_settlement_correction_audit
  ENABLE ROW LEVEL SECURITY;

-- 2) Revoke PostgREST client access (anon key + normal user JWT)
REVOKE ALL ON TABLE public.historical_settlement_correction_audit FROM anon;
REVOKE ALL ON TABLE public.historical_settlement_correction_audit FROM authenticated;

-- 3) Explicit backend grants (service_role bypasses RLS; keep project-style grants)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.historical_settlement_correction_audit
  TO service_role;

-- 4) No CREATE POLICY for anon / authenticated — table must stay unreachable
--    from client apps and normal authenticated users.

-- 5) Fix mutable search_path WARN without changing behaviour.
--    Function body only RAISE EXCEPTION; no relation lookups.
CREATE OR REPLACE FUNCTION public.historical_settlement_correction_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'historical_settlement_correction_audit is append-only';
END;
$function$;

COMMIT;
