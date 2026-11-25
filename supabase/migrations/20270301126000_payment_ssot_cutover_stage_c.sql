-- Stage C — Validate ownership, snapshot coverage, provider evidence, diagnostics.
-- Claim fencing preferred; soft-skip only for genuinely missing migration (Stage A/B).
-- Still does NOT enable Stage D strict flags.
-- Rollback: UPDATE payment_ssot_cutover SET stage='B' WHERE id=1;

UPDATE public.payment_ssot_cutover
SET
  stage = 'C',
  require_financial_op_claim = false,
  strict_trip_capture_mirror = false,
  updated_at = now()
WHERE id = 1;
