-- Stage B — Writers/readers active; soft claim still allowed when migration missing.
-- Compatible with existing production data and active trips.
-- Does NOT enable require_financial_op_claim or strict_trip_capture_mirror.
-- Rollback: UPDATE payment_ssot_cutover SET stage='A' WHERE id=1;

UPDATE public.payment_ssot_cutover
SET
  stage = 'B',
  require_financial_op_claim = false,
  strict_trip_capture_mirror = false,
  updated_at = now()
WHERE id = 1;
