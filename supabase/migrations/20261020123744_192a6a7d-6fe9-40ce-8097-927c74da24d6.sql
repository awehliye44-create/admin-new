-- HISTORY PARITY ONLY. Already applied on linked production.
-- Restored so local migration list matches remote. Do not re-apply via db push.
CREATE OR REPLACE FUNCTION public.driver_wallet_resolve_economic_date(p_type text, p_related_trip_id uuid, p_created_at timestamp with time zone)
 RETURNS TABLE(economic_earned_at timestamp with time zone, posting_created_at timestamp with time zone, economic_date_status text, captured_at timestamp with time zone, eligible_at timestamp with time zone, clearing_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_model text;
  v_booking_count integer := 0;
  v_capture_evidence_count integer := 0;
  v_missing_ts boolean := false;
  v_refunded boolean := false;
  v_released boolean := false;
  v_unverified boolean := false;
  v_captured timestamptz := NULL;
  v_eligible timestamptz := NULL;
  v_clearing text := NULL;
  v_delay numeric := 27;
  v_status text;
BEGIN
  posting_created_at := p_created_at;

  IF upper(coalesce(p_type, '')) <> 'TRIP_EARNING_NET' THEN
    economic_earned_at := p_created_at;
    economic_date_status := 'POSTING_CREATED_AT'::text;
    captured_at := NULL::timestamptz;
    eligible_at := NULL::timestamptz;
    clearing_status := NULL::text;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_related_trip_id IS NULL THEN
    economic_earned_at := NULL::timestamptz;
    economic_date_status := 'PAYMENT_SESSION_MISSING'::text;
    captured_at := NULL::timestamptz;
    eligible_at := NULL::timestamptz;
    clearing_status := NULL::text;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT t.financial_model::text
  INTO v_model
  FROM public.trips t
  WHERE t.id = p_related_trip_id;

  IF upper(coalesce(v_model, '')) IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    economic_earned_at := NULL::timestamptz;
    economic_date_status := 'FINANCIAL_MODEL_MISMATCH'::text;
    captured_at := NULL::timestamptz;
    eligible_at := NULL::timestamptz;
    clearing_status := NULL::text;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Canonical origin is RIDE_BOOKING only. Exactly one RIDE_BOOKING row is required.
  SELECT COUNT(*)::integer
  INTO v_booking_count
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_related_trip_id
    AND ps.purpose = 'RIDE_BOOKING'::public.payment_session_purpose;

  IF v_booking_count = 0 THEN
    v_status := 'PAYMENT_SESSION_MISSING'::text;
  ELSIF v_booking_count > 1 THEN
    v_status := 'CAPTURE_AMBIGUOUS'::text;
    v_captured := NULL::timestamptz;
  ELSE
    SELECT
      COUNT(*) FILTER (
        WHERE ps.captured_at IS NOT NULL
          AND coalesce(ps.captured_amount_pence, 0) > 0
          AND ps.refunded_at IS NULL
          AND coalesce(ps.refunded_amount_pence, 0) = 0
          AND upper(ps.status::text) NOT IN ('REFUNDED', 'RELEASED')
          AND (
            -- A CAPTURED session's residual buffer release (authorised minus captured)
            -- is not a capture release; the captured amount stands.
            (upper(ps.status::text) = 'CAPTURED')
            OR (
              ps.released_at IS NULL
              AND coalesce(ps.released_amount_pence, 0) = 0
              AND coalesce(upper(ps.hold_release_state), '') NOT LIKE '%RELEASE%'
            )
          )
          AND upper(coalesce(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
          AND ps.provider_state_verified_at IS NOT NULL
      )::integer,
      bool_or(ps.captured_at IS NULL),
      bool_or(
        ps.refunded_at IS NOT NULL
        OR coalesce(ps.refunded_amount_pence, 0) > 0
        OR upper(ps.status::text) = 'REFUNDED'
      ),
      bool_or(
        ps.released_at IS NOT NULL
        OR coalesce(ps.released_amount_pence, 0) > 0
        OR upper(ps.status::text) = 'RELEASED'
        OR upper(coalesce(ps.hold_release_state, '')) LIKE '%RELEASE%'
      ),
      bool_or(
        ps.captured_at IS NOT NULL
        AND coalesce(ps.captured_amount_pence, 0) > 0
        AND ps.refunded_at IS NULL
        AND ps.released_at IS NULL
        AND coalesce(ps.refunded_amount_pence, 0) = 0
        AND coalesce(ps.released_amount_pence, 0) = 0
        AND (
          upper(coalesce(ps.provider_state, '')) NOT IN ('COMPLETED', 'CAPTURED')
          OR ps.provider_state_verified_at IS NULL
        )
      ),
      MIN(ps.captured_at) FILTER (
        WHERE ps.captured_at IS NOT NULL
          AND coalesce(ps.captured_amount_pence, 0) > 0
          AND ps.refunded_at IS NULL
          AND coalesce(ps.refunded_amount_pence, 0) = 0
          AND upper(ps.status::text) NOT IN ('REFUNDED', 'RELEASED')
          AND (
            (upper(ps.status::text) = 'CAPTURED')
            OR (
              ps.released_at IS NULL
              AND coalesce(ps.released_amount_pence, 0) = 0
              AND coalesce(upper(ps.hold_release_state), '') NOT LIKE '%RELEASE%'
            )
          )
          AND upper(coalesce(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
          AND ps.provider_state_verified_at IS NOT NULL
      )
    INTO v_capture_evidence_count, v_missing_ts, v_refunded, v_released, v_unverified, v_captured
    FROM public.payment_sessions ps
    WHERE ps.trip_id = p_related_trip_id
      AND ps.purpose = 'RIDE_BOOKING'::public.payment_session_purpose;

    IF v_capture_evidence_count = 1 THEN
      v_status := 'RESOLVED'::text;
    ELSIF v_refunded AND NOT v_released THEN
      v_status := 'CAPTURE_REFUNDED'::text;
      v_captured := NULL::timestamptz;
    ELSIF v_released THEN
      v_status := 'CAPTURE_RELEASED'::text;
      v_captured := NULL::timestamptz;
    ELSIF v_missing_ts THEN
      v_status := 'CAPTURE_TIMESTAMP_MISSING'::text;
      v_captured := NULL::timestamptz;
    ELSIF v_unverified THEN
      v_status := 'CAPTURE_NOT_VERIFIED'::text;
      v_captured := NULL::timestamptz;
    ELSE
      v_status := 'PAYMENT_SESSION_MISSING'::text;
      v_captured := NULL::timestamptz;
    END IF;
  END IF;

  IF v_status = 'RESOLVED' THEN
    v_delay := public.driver_wallet_payout_clearing_delay_hours();
    v_eligible := v_captured + pg_catalog.make_interval(hours => v_delay::integer);
    IF pg_catalog.now() >= v_eligible THEN
      v_clearing := 'AVAILABLE';
    ELSE
      v_clearing := 'PENDING';
    END IF;
    economic_earned_at := v_captured;
    economic_date_status := 'RESOLVED'::text;
    captured_at := v_captured;
    eligible_at := v_eligible;
    clearing_status := v_clearing;
  ELSE
    economic_earned_at := NULL::timestamptz;
    economic_date_status := v_status;
    captured_at := NULL::timestamptz;
    eligible_at := NULL::timestamptz;
    clearing_status := NULL::text;
  END IF;

  RETURN NEXT;
END;
$function$;