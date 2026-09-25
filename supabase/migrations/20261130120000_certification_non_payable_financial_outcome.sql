-- DRAFT ONLY — do not apply to production without separate approval.
-- Decision A: reuse existing trips.financial_outcome (text, unconstrained).
-- New canonical value: CERTIFICATION_NON_PAYABLE
--
-- Explicit zero settlement stamps are written by Review & repair Apply
-- (driver_net_pence=0, commission_pence=0, …). Commission RATE columns stay NULL
-- (“commission does not apply” ≠ “0% commission”).
--
-- Prevention (code, not this migration): certification trip inserts must set
-- payment_session_id = NULL.
--
-- Ownership invariant (PROPOSED — not enforced yet):
--   IF trips.payment_session_id IS NOT NULL THEN
--     payment_sessions.trip_id MUST equal trips.id
-- Do NOT add a UNIQUE(trips.payment_session_id) or FK ownership CHECK until
-- legacy duplicates are counted and reviewed (read-only audit found 2 groups).

COMMENT ON COLUMN public.trips.financial_outcome IS
  'Canonical financial outcome. Includes COMPLETED, NO_SHOW, CANCELLED_WITH_FEE, '
  'CANCELLED_NO_FEE, LATE_PASSENGER_CANCELLATION, CERTIFICATION_NON_PAYABLE. '
  'CERTIFICATION_NON_PAYABLE = verified certification/test trip; expected driver '
  'entitlement and commission are explicitly zero; commission rate columns remain '
  'NULL (no commission applies).';

-- Allow certification audit events on the existing repair audit table.
ALTER TABLE public.driver_financial_repair_audit
  DROP CONSTRAINT IF EXISTS driver_financial_repair_audit_event_type_check;

ALTER TABLE public.driver_financial_repair_audit
  ADD CONSTRAINT driver_financial_repair_audit_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'DRIVER_FINANCIAL_REPAIR_PREVIEWED'::text,
    'EXPECTED_STAMP_RESTORED'::text,
    'WALLET_CORRECTION_APPENDED'::text,
    'RECONCILIATION_RECOMPUTED'::text,
    'FALSE_FREEZE_CLEARED'::text,
    'CERTIFICATION_NON_PAYABLE_MARKED'::text,
    'STALE_PAYMENT_SESSION_LINK_CLEARED'::text,
    'FINANCIAL_REPAIR_BLOCKED'::text
  ]));

-- Soft documentation only — no ownership CHECK/UNIQUE enforced in this draft.
-- Future (after duplicate cleanup): trigger enforcing
--   trips.payment_session_id IS NULL
--   OR payment_sessions.trip_id = trips.id
-- for the referenced session.
