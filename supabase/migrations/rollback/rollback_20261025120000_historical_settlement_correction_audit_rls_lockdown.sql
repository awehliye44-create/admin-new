-- ============================================================
-- ROLLBACK for 20261025120000_historical_settlement_correction_audit_rls_lockdown.sql
--
-- Restores pre-lockdown grants + RLS disabled + original function
-- search_path (proconfig NULL / unset).
--
-- Does NOT delete or mutate audit rows.
-- Does NOT remove the forward migration from schema_migrations
-- (run only when explicitly needed; prefer a new forward fix).
-- ============================================================

BEGIN;

-- 1) Restore previous client grants (pre-audit state)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.historical_settlement_correction_audit
  TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.historical_settlement_correction_audit
  TO authenticated;

-- Keep service_role grants (were already present pre-migration)
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.historical_settlement_correction_audit
  TO service_role;

-- 2) Disable RLS
ALTER TABLE public.historical_settlement_correction_audit
  DISABLE ROW LEVEL SECURITY;

-- 3) Restore function without fixed search_path (matches pre-migration proconfig NULL)
CREATE OR REPLACE FUNCTION public.historical_settlement_correction_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'historical_settlement_correction_audit is append-only';
END;
$function$;

COMMIT;
