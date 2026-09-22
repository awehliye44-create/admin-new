-- Rollback tip-window trigger mutex (PR #66). Does not rewrite historical CLOSED rows.

DROP FUNCTION IF EXISTS public.stamp_tip_window_capture_idempotency_key(uuid, uuid, text, timestamptz);
DROP FUNCTION IF EXISTS public.reclaim_stale_tip_window_expiry_after_authorised_get(uuid, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.finalize_tip_window_expired_after_provider_capture(uuid, integer, timestamptz);
DROP FUNCTION IF EXISTS public.finalize_tip_window_trigger(uuid, uuid, text, integer, timestamptz);
DROP FUNCTION IF EXISTS public.release_tip_window_trigger_claim(uuid, uuid, boolean, timestamptz);
DROP FUNCTION IF EXISTS public.claim_tip_window_trigger(uuid, text, uuid, timestamptz);

ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_tip_window_trigger_check;
ALTER TABLE public.trips DROP CONSTRAINT IF EXISTS trips_tip_window_status_check;

-- Restore open|closed-only check; remap processing/expired → open/closed first.
UPDATE public.trips
SET tip_window_status = CASE
  WHEN tip_window_status = 'expired' THEN 'closed'
  WHEN tip_window_status = 'processing' THEN 'open'
  ELSE tip_window_status
END
WHERE tip_window_status IN ('expired', 'processing');

ALTER TABLE public.trips
  ADD CONSTRAINT trips_tip_window_status_check
  CHECK (
    tip_window_status IS NULL
    OR tip_window_status IN ('open', 'closed')
  );

ALTER TABLE public.trips DROP COLUMN IF EXISTS tip_window_capture_idempotency_key;
ALTER TABLE public.trips DROP COLUMN IF EXISTS tip_window_claimed_at;
ALTER TABLE public.trips DROP COLUMN IF EXISTS tip_window_claim_token;
ALTER TABLE public.trips DROP COLUMN IF EXISTS tip_window_trigger;
