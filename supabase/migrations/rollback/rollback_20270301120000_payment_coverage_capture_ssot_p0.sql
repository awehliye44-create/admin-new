-- Rollback Stage A Payment Coverage & Capture SSOT (local/dev only).
-- Does not mutate historical money. Never restore false-captured behaviour.
-- PRODUCTION: NEVER run this while payment_financial_operations rows exist or
-- while Edge workers may still reference fences — prefer Stage D→C flag rollback
-- (rollback_20270301130000_…) and retain evidence tables permanently.
-- Confirmed capture_confirmed_pence projection is dropped with columns — keep a
-- backup if rolling back after any production use.
-- Before Edge rollback to 871c73ac: require inflight_count=0 AND unresolved_count=0
-- (see paymentSsotQuiescenceSSOT.decideEdgeRollbackSafety).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payment_financial_operations'
  ) AND EXISTS (
    SELECT 1 FROM public.payment_financial_operations
    WHERE provider_post_inflight = true
       OR state IN (
         'INCREMENT_REQUESTED','INCREMENT_PENDING','INCREMENT_UNKNOWN',
         'CAPTURE_REQUESTED','CAPTURE_PENDING','CAPTURE_UNKNOWN','RECONCILING'
       )
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'REFUSING Stage A schema rollback: unresolved/inflight financial operations exist. Quiesce first.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_trips_capture_amount_confirmed_only ON public.trips;
DROP FUNCTION IF EXISTS public.trips_capture_amount_confirmed_only();

DROP TRIGGER IF EXISTS trg_payment_financial_events_sanitize ON public.payment_financial_events;
DROP FUNCTION IF EXISTS public.payment_financial_events_sanitize_detail();

DROP TABLE IF EXISTS public.payment_financial_events;
DROP TABLE IF EXISTS public.payment_financial_operations;
DROP TABLE IF EXISTS public.payment_payable_snapshots;
DROP TABLE IF EXISTS public.payment_ssot_cutover;

ALTER TABLE public.payment_sessions
  DROP COLUMN IF EXISTS financial_operation_fence,
  DROP COLUMN IF EXISTS capture_confirmation_state,
  DROP COLUMN IF EXISTS capture_confirmed_pence,
  DROP COLUMN IF EXISTS capture_requested_pence;
