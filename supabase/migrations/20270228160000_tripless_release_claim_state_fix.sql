-- #89A: claim_payment_session_tripless_release wrote hold_release_state='releasing',
-- which violates payment_sessions_hold_release_state_check
-- (NULL | release_pending | release_failed | released).
-- That blocked orphan AUTHORISED hold release (MK-261124-002 screenshot order).
-- Use release_pending as the in-flight claim marker.

CREATE OR REPLACE FUNCTION public.claim_payment_session_tripless_release(
  p_session_id uuid,
  p_reason text DEFAULT NULL,
  p_source text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ps public.payment_sessions%ROWTYPE;
  v_now timestamptz := now();
  v_hold text;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'missing_session_id');
  END IF;

  SELECT * INTO v_ps
  FROM public.payment_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_ps.trip_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'has_trip',
      'trip_id', v_ps.trip_id
    );
  END IF;

  IF v_ps.released_at IS NOT NULL OR v_ps.captured_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'already_terminal',
      'idempotent', true,
      'hold_release_state', v_ps.hold_release_state
    );
  END IF;

  v_hold := lower(COALESCE(v_ps.hold_release_state, ''));
  IF v_hold IN ('released', 'captured') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'already_terminal',
      'idempotent', true,
      'hold_release_state', v_ps.hold_release_state
    );
  END IF;

  -- In-flight claim marker must be an allowed CHECK value.
  IF v_hold IN ('releasing', 'release_pending') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'claim_held',
      'idempotent', true,
      'hold_release_state', 'release_pending'
    );
  END IF;

  UPDATE public.payment_sessions
  SET
    hold_release_state = 'release_pending',
    release_attempt_count = COALESCE(release_attempt_count, 0) + 1,
    updated_at = v_now,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'tripless_release_claimed_at', v_now,
      'tripless_release_reason', NULLIF(trim(COALESCE(p_reason, '')), ''),
      'tripless_release_source', NULLIF(trim(COALESCE(p_source, '')), '')
    )
  WHERE id = p_session_id
    AND trip_id IS NULL
    AND released_at IS NULL
    AND captured_at IS NULL
    AND lower(COALESCE(hold_release_state, '')) IS DISTINCT FROM 'release_pending'
    AND lower(COALESCE(hold_release_state, '')) IS DISTINCT FROM 'releasing';

  IF NOT FOUND THEN
    SELECT * INTO v_ps FROM public.payment_sessions WHERE id = p_session_id;
    IF v_ps.trip_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'has_trip', 'trip_id', v_ps.trip_id);
    END IF;
    IF lower(COALESCE(v_ps.hold_release_state, '')) IN ('releasing', 'release_pending') THEN
      RETURN jsonb_build_object(
        'ok', true,
        'code', 'claim_held',
        'idempotent', true,
        'hold_release_state', 'release_pending'
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'claim_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'claimed',
    'idempotent', false,
    'hold_release_state', 'release_pending'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) TO service_role;
