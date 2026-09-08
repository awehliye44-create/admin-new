-- ============================================================
-- Later isolated draft: record_cash_trip_completion retirement
-- NOT APPLIED until explicitly approved.
--
-- Preserve the live five-argument signature and uuid return type.
-- Body becomes an immediate digital-only exception. No writes.
-- Revoke PUBLIC, anon, authenticated and service_role.
-- Leave postgres owner access only. Do not drop the function.
-- Does not rewrite historical cash trips.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.record_cash_trip_completion(
  p_trip_id uuid,
  p_driver_id uuid,
  p_gross_fare_pence integer,
  p_commission_pence integer,
  p_currency_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Cash trip completion is no longer supported. ONECAB is digital-only.'
    USING ERRCODE = 'check_violation';
END;
$fn$;

COMMENT ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) IS
  'Retired digital-only stub. FINANCIAL_MODEL_VIOLATION. Does not write fare or ledger state.';

REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM service_role;

COMMIT;
