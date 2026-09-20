-- ============================================================
-- Forward: Lovable advisor remediation
--   1) corporate_schedule_holds — rls_disabled_in_public / no access control
--   2) protect_trip_invoice_email_columns — function_search_path_mutable
--
-- Intent:
--   Enable + FORCE RLS on corporate_schedule_holds; revoke client grants;
--   service_role DML only; no anon/authenticated policies.
--   Pin search_path on protect_trip_invoice_email_columns (auth.role only).
--
-- Does NOT change hold claim RPC behaviour (already service_role-only EXECUTE).
-- Rollback:
--   supabase/migrations/rollback/rollback_20261112230000_corporate_holds_rls_and_search_path.sql
-- ============================================================

BEGIN;

-- 1) Corporate schedule holds — deny-by-default for PostgREST clients
ALTER TABLE public.corporate_schedule_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.corporate_schedule_holds FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.corporate_schedule_holds FROM PUBLIC;
REVOKE ALL ON TABLE public.corporate_schedule_holds FROM anon;
REVOKE ALL ON TABLE public.corporate_schedule_holds FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.corporate_schedule_holds
  TO service_role;

-- No CREATE POLICY for anon / authenticated — unreachable from client apps.

-- 2) Pin search_path on receipt email column guard (uses auth.role() only)
CREATE OR REPLACE FUNCTION public.protect_trip_invoice_email_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text := auth.role();
BEGIN
  IF v_role IS NULL OR v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_email_sent IS DISTINCT FROM OLD.invoice_email_sent
     OR NEW.invoice_email_sent_at IS DISTINCT FROM OLD.invoice_email_sent_at
     OR NEW.invoice_email_status IS DISTINCT FROM OLD.invoice_email_status
     OR NEW.invoice_email_error IS DISTINCT FROM OLD.invoice_email_error
     OR NEW.invoice_email_recipient IS DISTINCT FROM OLD.invoice_email_recipient
     OR NEW.invoice_email_sent_by IS DISTINCT FROM OLD.invoice_email_sent_by
     OR NEW.invoice_email_source IS DISTINCT FROM OLD.invoice_email_source
  THEN
    RAISE EXCEPTION 'invoice email fields are written only by the receipt sender'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
