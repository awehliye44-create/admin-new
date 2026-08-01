-- Finish expire-offers scan_go cleanup after edge redeploy (2026-07-30).
-- Stub added in 20260907140000 so undeployed expire-offers could SELECT scan_go.
-- Local + deployed expire-offers no longer reference the column.

ALTER TABLE public.trips DROP COLUMN IF EXISTS scan_go;

COMMENT ON TABLE public.trips IS
  'Customer trips. Retired Scan & Go column stub (scan_go) removed after expire-offers redeploy.';
