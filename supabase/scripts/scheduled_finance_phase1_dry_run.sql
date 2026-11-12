-- Phase 1 dry-run / backfill helpers (DO NOT apply migrations or flip enforcement
-- until explicit production release approval).
--
-- Run against linked project with supabase db query --linked -f ...

-- 1) Classify non-terminal scheduled card sessions
SELECT *
FROM public.classify_scheduled_capture_deadline_backfill(true);

-- 2) Normalise historical terminal payment_gate_blocked rows (dry-run)
SELECT *
FROM public.normalise_payment_gate_blocked_terminal_rows(true);

-- 3) Open payment_gate_blocked bookings (ops visibility — same board as /scheduled-rides)
SELECT
  t.id,
  t.trip_code,
  t.status,
  t.scheduled_status,
  t.scheduled_at,
  t.payment_method,
  ps.capture_deadline,
  ps.provider_state,
  ps.provider_order_id
FROM public.trips t
LEFT JOIN public.payment_sessions ps ON ps.id = t.payment_session_id
WHERE t.scheduled_status::text = 'payment_gate_blocked'
ORDER BY t.scheduled_at NULLS LAST;

-- 4) After backfill verify (manual Revolut retrieve → UPDATE capture_deadline),
--    flip enforcement ONLY with release approval:
-- UPDATE public.global_dispatch_settings
--    SET scheduled_capture_coverage_enforced = true, updated_at = now()
--  WHERE singleton = true;
