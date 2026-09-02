-- REVIEW ONLY — DO NOT APPLY IN PRODUCTION WITHOUT EXPLICIT APPROVAL.
-- Reversible repair for payment_sessions.captured_at restamped by admin-refresh-payment-sessions.
--
-- Restores economic capture time from trip completion or wallet ledger credit when:
--   captured_at > trip.completed_at + 48h AND ledger was credited before captured_at.
--
-- Rollback: restore from backup table created below.

BEGIN;

CREATE TABLE IF NOT EXISTS public._review_captured_at_repair_backup (
  payment_session_id uuid PRIMARY KEY,
  captured_at_before timestamptz,
  captured_at_after timestamptz,
  repaired_at timestamptz NOT NULL DEFAULT now(),
  repair_reason text NOT NULL DEFAULT 'CAPTURED_AT_RESTAMP_SUSPECT'
);

-- Preview only — uncomment APPLY block after review.

/*
INSERT INTO public._review_captured_at_repair_backup (payment_session_id, captured_at_before, captured_at_after)
SELECT
  ps.id,
  ps.captured_at,
  COALESCE(
    (ps.metadata->>'first_captured_at')::timestamptz,
    t.completed_at,
    l.ledger_created_at
  ),
  now()
FROM public.payment_sessions ps
INNER JOIN public.trips t ON t.id = ps.trip_id
INNER JOIN LATERAL (
  SELECT MIN(l.created_at) AS ledger_created_at
  FROM public.driver_wallet_ledger l
  WHERE l.related_trip_id = t.id
    AND l.type = 'TRIP_EARNING_NET'
    AND l.amount_pence > 0
) l ON true
WHERE ps.captured_at IS NOT NULL
  AND t.completed_at IS NOT NULL
  AND l.ledger_created_at IS NOT NULL
  AND ps.captured_at > t.completed_at + interval '48 hours'
  AND l.ledger_created_at < ps.captured_at
ON CONFLICT (payment_session_id) DO NOTHING;

UPDATE public.payment_sessions ps
SET
  captured_at = b.captured_at_after,
  metadata = COALESCE(ps.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'first_captured_at', COALESCE(ps.metadata->>'first_captured_at', b.captured_at_before::text),
      'captured_at_repaired_at', now()::text,
      'captured_at_repair_reason', 'CAPTURED_AT_RESTAMP_SUSPECT'
    ),
  updated_at = now()
FROM public._review_captured_at_repair_backup b
WHERE ps.id = b.payment_session_id
  AND b.captured_at_after IS NOT NULL
  AND b.captured_at_after <> ps.captured_at;
*/

ROLLBACK;
