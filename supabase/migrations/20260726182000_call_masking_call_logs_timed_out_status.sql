-- Allow timed_out (and other provider-neutral terminals) on call_masking_call_logs.status.
-- Additive: widen CHECK only; do not rewrite historical rows.

ALTER TABLE public.call_masking_call_logs
  DROP CONSTRAINT IF EXISTS call_masking_call_logs_status_check;

ALTER TABLE public.call_masking_call_logs
  ADD CONSTRAINT call_masking_call_logs_status_check
  CHECK (status = ANY (ARRAY[
    'active'::text,
    'completed'::text,
    'disconnected'::text,
    'timed_out'::text,
    'failed'::text,
    'missed'::text,
    'cancelled'::text,
    'declined'::text
  ]));
