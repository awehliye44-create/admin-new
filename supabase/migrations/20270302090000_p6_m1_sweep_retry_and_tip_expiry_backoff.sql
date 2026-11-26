-- P6 M1: recovery starvation.
--
-- A) trips: bounded per-trip backoff for capture-expired-tip-windows so a
--    permanently failing tip/shortfall row cannot monopolise the 50-row window.
--    (trips has no metadata column; two minimal columns instead.)
-- B) payment_sessions: atomic merge of sweep_* retry keys into metadata for
--    sweep-revolut-stale-holds (metadata only — no status/provider_state writes).
-- C) has_work gate honours the backoff so the 5s cron stops waking the Edge
--    function for rows that are all deferred.

-- A) ------------------------------------------------------------------------
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS tip_window_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS tip_window_expiry_attempt_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.trips.tip_window_next_attempt_at IS
  'P6 M1: capture-expired-tip-windows skips this trip until this time (bounded exponential backoff after a failed expiry attempt). NULL = due now.';
COMMENT ON COLUMN public.trips.tip_window_expiry_attempt_count IS
  'P6 M1: failed expiry-capture attempts so far; drives tip_window_next_attempt_at backoff.';

-- B) ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_payment_session_sweep_retry(
  p_session_id uuid,
  p_attempts integer,
  p_next_at timestamptz,
  p_last_outcome text,
  p_capture_ambiguous boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rows integer;
BEGIN
  -- Single-statement jsonb merge: cannot clobber concurrent disposition metadata.
  UPDATE public.payment_sessions
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'sweep_attempts', GREATEST(0, COALESCE(p_attempts, 0)),
        -- ISO-8601 UTC with milliseconds: lexicographically comparable in PostgREST filters.
        'sweep_next_at', to_char(p_next_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sweep_last_outcome', left(COALESCE(p_last_outcome, ''), 80),
        'sweep_capture_ambiguous', COALESCE(p_capture_ambiguous, false),
        'sweep_last_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
  WHERE id = p_session_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_payment_session_sweep_retry(uuid, integer, timestamptz, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stamp_payment_session_sweep_retry(uuid, integer, timestamptz, text, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stamp_payment_session_sweep_retry(uuid, integer, timestamptz, text, boolean) TO service_role;

-- C) ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.tip_window_expires_at IS NOT NULL
      AND t.tip_window_expires_at < now()
      AND t.tip_window_closed_at IS NULL
      AND (
        (
          (t.provider_order_id IS NOT NULL OR t.payment_intent_id IS NOT NULL)
          AND (t.tip_window_next_attempt_at IS NULL OR t.tip_window_next_attempt_at <= now())
          AND t.payment_status IN (
            'preauth_created',
            'preauth_authorized',
            'preauth_authorised',
            'authorized',
            'authorised',
            'preauth_updated',
            'capture_requested',
            'capture_failed',
            'payment_shortfall',
            'recovery_required'
          )
        )
        OR t.payment_status IN ('captured', 'paid', 'collected_cash')
      )
    LIMIT 1
  );
$$;
