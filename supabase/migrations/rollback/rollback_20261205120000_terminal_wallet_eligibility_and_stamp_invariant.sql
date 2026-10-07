-- Rollback for 20261205120000_terminal_wallet_eligibility_and_stamp_invariant.sql
-- Restores the production function bodies captured 2026-10-02 and the original
-- trips_driver_net_pence_matches_breakdown constraint.
-- The old constraint is added NOT VALID: terminal rows stamped under the new
-- invariant (gross − commission − fee) stay in place and are not rewritten.

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances(p_driver_id uuid)
 RETURNS TABLE(live_balance_pence bigint, available_balance_pence bigint, pending_balance_pence bigint, withdrawal_in_progress_pence bigint, outstanding_debt_pence bigint, eligible_earnings_pence bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live bigint := 0;
  v_debt bigint := 0;
  v_reserved bigint := 0;
  v_in_flight bigint := 0;
  v_withdrawal bigint := 0;
  v_eligible bigint := 0;
  v_pending bigint := 0;
  v_unpaid_eligible bigint := 0;
  v_available bigint := 0;
  v_delay_hours numeric := 48;
  v_operational_paused boolean := false;
  r record;
  v_captured bigint;
  v_canonical bigint;
  v_refunded bigint;
  v_session_status text;
  v_allocated bigint;
  v_unpaid bigint;
  v_model text;
  v_method text;
  v_requires_clearing boolean;
  v_cleared boolean;
  v_origin timestamptz;
  v_first_captured timestamptz;
BEGIN
  PERFORM public.assert_driver_wallet_read_access(p_driver_id);

  v_live := public.driver_wallet_live_balance_pence(p_driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_in_flight := public.driver_wallet_other_holds_pence(p_driver_id);
  v_withdrawal := GREATEST(0, v_reserved) + GREATEST(0, v_in_flight);
  v_delay_hours := public.driver_wallet_payout_clearing_delay_hours();

  SELECT COALESCE(payout_operational_paused, false)
  INTO v_operational_paused
  FROM public.drivers
  WHERE id = p_driver_id;

  SELECT GREATEST(
    0,
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN abs(amount_pence) ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN abs(amount_pence) ELSE 0 END), 0)
  )::bigint
  INTO v_debt
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id;

  -- A8B28F Stage C: operational pause zeros Available; verification does NOT.
  IF v_operational_paused IS TRUE THEN
    RETURN QUERY SELECT
      v_live,
      0::bigint,
      GREATEST(0, v_live)::bigint,
      v_withdrawal,
      GREATEST(0, v_debt)::bigint,
      0::bigint;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      l.id AS ledger_id,
      l.type,
      l.amount_pence,
      l.related_trip_id,
      l.created_at,
      t.payment_collection_model::text AS payment_collection_model,
      t.financial_model::text AS financial_model,
      t.payment_method AS trip_payment_method,
      t.status::text AS trip_status,
      t.cancelled_at AS trip_cancelled_at,
      t.completed_at AS trip_completed_at,
      t.driver_net_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.provider_available_on AS trip_provider_available_on,
      ps.id AS session_id,
      ps.captured_amount_pence,
      ps.captured_at,
      ps.metadata AS session_metadata,
      ps.refunded_amount_pence,
      ps.status::text AS session_status,
      ps.provider_state,
      ps.payment_method AS session_payment_method,
      des.settled_at,
      des.settlement_status,
      des.provider_available_on AS des_provider_available_on,
      des.capture_time,
      des.allocated_to_payout,
      des.allocated_amount_pence,
      des.paid_in_batch_id,
      des.paid_in_payout_item_id,
      COALESCE(alloc.allocated_sum, 0)::bigint AS alloc_sum
    FROM public.driver_wallet_ledger l
    LEFT JOIN public.trips t ON t.id = l.related_trip_id
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM public.payment_sessions s
      WHERE s.id = t.payment_session_id
         OR s.trip_id = t.id
      ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST
      LIMIT 1
    ) ps ON true
    LEFT JOIN LATERAL (
      SELECT d.*
      FROM public.driver_earning_settlement d
      WHERE d.ledger_entry_id = l.id
      ORDER BY d.updated_at DESC NULLS LAST
      LIMIT 1
    ) des ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount_pence), 0) AS allocated_sum
      FROM public.payout_item_ledger_allocations a
      INNER JOIN public.payout_items pi ON pi.id = a.payout_item_id
      WHERE a.ledger_entry_id = l.id
        AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status)
    ) alloc ON true
    WHERE l.driver_id = p_driver_id
      AND l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT')
      AND l.amount_pence > 0
  LOOP
    IF r.paid_in_batch_id IS NOT NULL
       OR r.allocated_to_payout IS TRUE
       OR r.paid_in_payout_item_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_allocated := GREATEST(
      COALESCE(r.alloc_sum, 0),
      COALESCE(r.allocated_amount_pence, 0)
    );
    v_unpaid := GREATEST(0, r.amount_pence - v_allocated);
    IF v_unpaid <= 0 THEN
      CONTINUE;
    END IF;

    IF r.related_trip_id IS NULL THEN
      CONTINUE;
    END IF;
    IF r.trip_cancelled_at IS NOT NULL THEN
      CONTINUE;
    END IF;
    IF lower(COALESCE(r.trip_status, '')) LIKE '%cancel%' THEN
      CONTINUE;
    END IF;
    IF lower(btrim(COALESCE(r.trip_status, ''))) <> 'completed'
       AND r.trip_completed_at IS NULL THEN
      CONTINUE;
    END IF;

    v_session_status := lower(COALESCE(r.session_status::text, ''));
    v_refunded := GREATEST(0, COALESCE(r.refunded_amount_pence, 0));
    IF v_refunded > 0
       OR v_session_status LIKE '%refund%'
       OR v_session_status LIKE '%chargeback%'
       OR v_session_status LIKE '%dispute%'
       OR v_session_status LIKE '%cancel%'
       OR v_session_status LIKE '%void%'
       OR lower(COALESCE(r.provider_state, '')) IN ('cancelled', 'canceled', 'failed', 'void') THEN
      CONTINUE;
    END IF;

    v_captured := CASE
      WHEN r.captured_amount_pence IS NULL THEN NULL
      ELSE round(r.captured_amount_pence)::bigint
    END;

    IF r.session_id IS NULL OR v_captured IS NULL OR v_captured <= 0 THEN
      CONTINUE;
    END IF;

    IF upper(r.type) = 'TRIP_EARNING_NET' THEN
      v_canonical := GREATEST(0, COALESCE(r.driver_net_pence, 0));
    ELSE
      v_canonical := GREATEST(0, COALESCE(r.tip_pence, r.tip_amount_pence, 0));
    END IF;

    IF v_canonical <= 0 OR r.amount_pence <> v_canonical THEN
      CONTINUE;
    END IF;

    IF v_captured < v_canonical THEN
      CONTINUE;
    END IF;

    v_model := upper(btrim(COALESCE(
      r.payment_collection_model::text,
      r.financial_model::text,
      'PLATFORM_COLLECTED'
    )));
    v_method := lower(btrim(COALESCE(r.trip_payment_method, r.session_payment_method, '')));
    v_requires_clearing := (v_model NOT LIKE '%DRIVER_COLLECTED%')
      AND v_method NOT LIKE '%cash%';

    v_cleared := NOT v_requires_clearing;
    IF v_requires_clearing THEN
      IF COALESCE(r.des_provider_available_on, r.trip_provider_available_on) IS NOT NULL
         AND COALESCE(r.des_provider_available_on, r.trip_provider_available_on) <= now() THEN
        v_cleared := true;
      ELSIF public.driver_wallet_provider_funds_cleared(r.provider_state) THEN
        v_cleared := true;
      ELSE
        v_first_captured := NULL;
        IF r.session_metadata IS NOT NULL
           AND jsonb_typeof(r.session_metadata) = 'object'
           AND NULLIF(btrim(r.session_metadata->>'first_captured_at'), '') IS NOT NULL THEN
          BEGIN
            v_first_captured := (r.session_metadata->>'first_captured_at')::timestamptz;
          EXCEPTION WHEN OTHERS THEN
            v_first_captured := NULL;
          END;
        END IF;

        v_origin := public.driver_wallet_stable_clearing_origin(
          r.captured_at,
          r.trip_completed_at,
          r.capture_time,
          r.created_at,
          v_first_captured
        );
        IF v_origin IS NOT NULL
           AND (v_origin + (v_delay_hours * interval '1 hour')) <= now() THEN
          v_cleared := true;
        END IF;
      END IF;
    END IF;

    IF v_cleared THEN
      v_eligible := v_eligible + v_unpaid;
    ELSE
      v_pending := v_pending + v_unpaid;
    END IF;
  END LOOP;

  v_unpaid_eligible := LEAST(
    GREATEST(0, v_eligible),
    GREATEST(0, GREATEST(0, v_live) - GREATEST(0, v_pending))
  );
  v_available := GREATEST(
    0,
    v_unpaid_eligible - GREATEST(0, v_debt) - v_withdrawal
  );

  RETURN QUERY SELECT
    v_live,
    v_available,
    GREATEST(0, v_pending)::bigint,
    v_withdrawal,
    GREATEST(0, v_debt)::bigint,
    GREATEST(0, v_unpaid_eligible)::bigint;
END;
$function$;

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

  SELECT t.financial_model::text INTO v_model
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

  -- Canonical origin is RIDE_BOOKING only. PAYMENT_RECOVERY is excluded by purpose
  -- and must not create booking-origin ambiguity.
  -- Exactly one RIDE_BOOKING row is required. Two rows always fail closed,
  -- even when provider_order_id / provider_capture_id / captured_at / amount match.
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
          AND ps.released_at IS NULL
          AND coalesce(ps.refunded_amount_pence, 0) = 0
          AND coalesce(ps.released_amount_pence, 0) = 0
          AND upper(ps.status::text) NOT IN ('REFUNDED', 'RELEASED')
          AND coalesce(upper(ps.hold_release_state), '') NOT LIKE '%RELEASE%'
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
          AND ps.released_at IS NULL
          AND coalesce(ps.refunded_amount_pence, 0) = 0
          AND coalesce(ps.released_amount_pence, 0) = 0
          AND upper(ps.status::text) NOT IN ('REFUNDED', 'RELEASED')
          AND coalesce(upper(ps.hold_release_state), '') NOT LIKE '%RELEASE%'
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

CREATE OR REPLACE FUNCTION public.list_driver_own_trip_history(p_limit integer DEFAULT 50, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_tab text DEFAULT NULL::text, p_trip_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_tab text := lower(nullif(trim(COALESCE(p_tab, '')), ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF v_tab IS NOT NULL AND v_tab NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_tab' USING ERRCODE = '22023';
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.sort_at DESC)
      FROM (
        SELECT
          deduped.id,
          deduped.public_trip_ref,
          deduped.backend_status,
          deduped.cancellation_reason_code,
          deduped.cancelled_by,
          deduped.cancelled_by_role,
          deduped.financial_outcome,
          deduped.arrival_cancellation_applied,
          deduped.service_area_label,
          deduped.pickup_area_label,
          deduped.dropoff_area_label,
          deduped.total_stops,
          deduped.requested_at,
          deduped.pickup_at,
          deduped.dropoff_at,
          deduped.cancelled_at,
          deduped.closed_at,
          deduped.payable_amount_pence,
          deduped.payable_source,
          deduped.has_card_payment_record,
          deduped.payment_method,
          deduped.financial_model,
          deduped.booking_type,
          deduped.vehicle_type,
          deduped.sort_at,
          deduped.is_active
        FROM (
          SELECT DISTINCT ON (combined.id)
            combined.id,
            combined.public_trip_ref,
            combined.backend_status,
            combined.cancellation_reason_code,
            combined.cancelled_by,
            combined.cancelled_by_role,
            combined.financial_outcome,
            combined.arrival_cancellation_applied,
            combined.service_area_label,
            combined.pickup_area_label,
            combined.dropoff_area_label,
            combined.total_stops,
            combined.requested_at,
            combined.pickup_at,
            combined.dropoff_at,
            combined.cancelled_at,
            combined.closed_at,
            combined.payable_amount_pence,
            combined.payable_source,
            combined.has_card_payment_record,
            combined.payment_method,
            combined.financial_model,
            combined.booking_type,
            combined.vehicle_type,
            combined.sort_at,
            combined.is_active
          FROM (
            -- A) Terminal trips this driver owned / was cancelled from
            SELECT
              t.id,
              COALESCE(t.trip_number, t.trip_code, left(t.id::text, 8)) AS public_trip_ref,
              t.status AS backend_status,
              COALESCE(t.cancellation_reason, t.cancel_reason, t.cancelled_by_role) AS cancellation_reason_code,
              t.cancelled_by,
              t.cancelled_by_role,
              t.financial_outcome,
              COALESCE(t.arrival_cancellation_applied, false) AS arrival_cancellation_applied,
              sa.name AS service_area_label,
              sa.name AS pickup_area_label,
              sa.name AS dropoff_area_label,
              COALESCE(t.total_stops, 1) AS total_stops,
              t.created_at AS requested_at,
              t.started_at AS pickup_at,
              t.completed_at AS dropoff_at,
              t.cancelled_at,
              CASE
                WHEN lower(COALESCE(t.status, '')) = 'no_show'
                  THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at)
                ELSE t.completed_at
              END AS closed_at,
              CASE
                WHEN upper(COALESCE(t.financial_outcome, '')) IN (
                  'ARRIVAL_CANCELLATION', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'
                )
                OR COALESCE(t.arrival_cancellation_applied, false)
                OR lower(COALESCE(t.status, '')) = 'no_show'
                  THEN (
                    SELECT l.amount_pence
                    FROM public.driver_wallet_ledger l
                    WHERE l.related_trip_id = t.id
                      AND l.driver_id = v_driver_id
                      AND l.type = 'TRIP_EARNING_NET'
                    ORDER BY l.created_at ASC
                    LIMIT 1
                  )
                ELSE COALESCE(
                  t.driver_total_earnings_pence,
                  t.driver_net_pence,
                  t.no_show_charge_pence,
                  t.cancellation_fee_pence,
                  t.late_cancel_fee_pence
                )
              END AS payable_amount_pence,
              CASE
                WHEN (
                  upper(COALESCE(t.financial_outcome, '')) IN (
                    'ARRIVAL_CANCELLATION', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'
                  )
                  OR COALESCE(t.arrival_cancellation_applied, false)
                  OR lower(COALESCE(t.status, '')) = 'no_show'
                )
                AND (
                  SELECT l.amount_pence
                  FROM public.driver_wallet_ledger l
                  WHERE l.related_trip_id = t.id
                    AND l.driver_id = v_driver_id
                    AND l.type = 'TRIP_EARNING_NET'
                  ORDER BY l.created_at ASC
                  LIMIT 1
                ) IS NOT NULL
                  THEN 'terminal_ledger'
                WHEN upper(COALESCE(t.financial_outcome, '')) IN (
                  'ARRIVAL_CANCELLATION', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'
                )
                OR COALESCE(t.arrival_cancellation_applied, false)
                OR lower(COALESCE(t.status, '')) = 'no_show'
                  THEN NULL::text
                ELSE 'trip_stamp'
              END AS payable_source,
              (t.payment_method IS NOT NULL AND lower(t.payment_method) IN ('card', 'apple_pay', 'google_pay', 'saved_card', 'revolut'))
                OR (t.provider_order_id IS NOT NULL)
                OR (t.payment_session_id IS NOT NULL) AS has_card_payment_record,
              t.payment_method,
              t.financial_model,
              t.booking_type,
              t.vehicle_type,
              COALESCE(
                CASE
                  WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                    THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
                  ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
                END,
                t.created_at
              ) AS sort_at,
              false AS is_active,
              1 AS source_pri
            FROM public.trips t
            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
            WHERE (
                t.driver_id = v_driver_id
                OR t.confirmed_driver_id = v_driver_id
                OR t.previous_driver_id = v_driver_id
                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
              )
              AND (
                p_trip_id IS NULL
                OR t.id = p_trip_id
              )
              AND lower(COALESCE(t.status, '')) IN (
                'completed',
                'no_show',
                'cancelled',
                'customer_cancelled',
                'driver_cancelled',
                'expired',
                'expired_no_driver',
                'missed'
              )
              AND (
                v_tab IS NULL
                OR (
                  v_tab = 'completed'
                  AND lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                )
                OR (
                  v_tab = 'cancelled'
                  AND lower(COALESCE(t.status, '')) IN (
                    'cancelled',
                    'customer_cancelled',
                    'driver_cancelled',
                    'expired',
                    'expired_no_driver',
                    'missed'
                  )
                )
              )
              AND (p_before IS NULL OR COALESCE(
                CASE
                  WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                    THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
                  ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
                END,
                t.created_at
              ) < p_before)

            UNION ALL

            -- B) Missed / lost offers (never assigned to this driver on trips)
            SELECT
              ro.trip_id AS id,
              COALESCE(t.trip_number, t.trip_code, left(ro.trip_id::text, 8)) AS public_trip_ref,
              CASE
                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
                  THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'passenger_cancelled', 'trip_cancelled', 'trip_terminal_cancel'
                ) THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'cancelled_by_admin', 'admin_cancelled'
                ) THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
                  THEN 'offer_expired'
                ELSE 'cancelled'
              END AS backend_status,
              CASE
                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
                  THEN 'accepted_by_another_driver'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'passenger_cancelled'
                  THEN 'passenger_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'trip_cancelled', 'trip_terminal_cancel'
                ) THEN 'passenger_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'cancelled_by_admin', 'admin_cancelled'
                ) THEN 'admin_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
                  THEN 'offer_expired'
                ELSE COALESCE(nullif(lower(ro.revoked_reason), ''), 'cancelled')
              END AS cancellation_reason_code,
              NULL::text AS cancelled_by,
              NULL::text AS cancelled_by_role,
              t.financial_outcome,
              COALESCE(t.arrival_cancellation_applied, false) AS arrival_cancellation_applied,
              sa.name AS service_area_label,
              sa.name AS pickup_area_label,
              sa.name AS dropoff_area_label,
              COALESCE(t.total_stops, 1) AS total_stops,
              COALESCE(ro.offered_at, ro.created_at) AS requested_at,
              NULL::timestamptz AS pickup_at,
              NULL::timestamptz AS dropoff_at,
              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS cancelled_at,
              NULL::timestamptz AS closed_at,
              CASE
                WHEN upper(COALESCE(t.financial_outcome, '')) IN (
                  'ARRIVAL_CANCELLATION', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'
                )
                OR COALESCE(t.arrival_cancellation_applied, false)
                OR lower(COALESCE(t.status, '')) = 'no_show'
                  THEN (
                    SELECT l.amount_pence
                    FROM public.driver_wallet_ledger l
                    WHERE l.related_trip_id = t.id
                      AND l.driver_id = v_driver_id
                      AND l.type = 'TRIP_EARNING_NET'
                    ORDER BY l.created_at ASC
                    LIMIT 1
                  )
                ELSE COALESCE(
                  ro.driver_offer_fare,
                  NULLIF(ro.offer_snapshot->>'driver_net_fare_pence', '')::int,
                  NULLIF(ro.offer_snapshot->>'driver_earnings_pence', '')::int,
                  NULLIF(ro.offer_snapshot->>'driver_net_preview_pence', '')::int
                )
              END AS payable_amount_pence,
              CASE
                WHEN (
                  upper(COALESCE(t.financial_outcome, '')) IN (
                    'ARRIVAL_CANCELLATION', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'
                  )
                  OR COALESCE(t.arrival_cancellation_applied, false)
                  OR lower(COALESCE(t.status, '')) = 'no_show'
                )
                AND (
                  SELECT l.amount_pence
                  FROM public.driver_wallet_ledger l
                  WHERE l.related_trip_id = t.id
                    AND l.driver_id = v_driver_id
                    AND l.type = 'TRIP_EARNING_NET'
                  ORDER BY l.created_at ASC
                  LIMIT 1
                ) IS NOT NULL
                  THEN 'terminal_ledger'
                WHEN upper(COALESCE(t.financial_outcome, '')) IN (
                  'ARRIVAL_CANCELLATION', 'NO_SHOW', 'LATE_PASSENGER_CANCELLATION'
                )
                OR COALESCE(t.arrival_cancellation_applied, false)
                OR lower(COALESCE(t.status, '')) = 'no_show'
                  THEN NULL::text
                ELSE 'offer_snapshot'
              END AS payable_source,
              false AS has_card_payment_record,
              t.payment_method,
              t.financial_model,
              t.booking_type,
              t.vehicle_type,
              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS sort_at,
              false AS is_active,
              2 AS source_pri
            FROM public.ride_offers ro
            INNER JOIN public.trips t ON t.id = ro.trip_id
            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
            WHERE ro.driver_id = v_driver_id
              AND (
                p_trip_id IS NULL
                OR ro.trip_id = p_trip_id
              )
              AND (
                v_tab IS NULL
                OR v_tab = 'cancelled'
              )
              AND lower(COALESCE(ro.status, '')) IN ('declined', 'expired', 'revoked')
              AND (
                lower(ro.status) IN ('declined', 'expired')
                OR lower(COALESCE(ro.revoked_reason, '')) IN (
                  'another_offer_accepted',
                  'passenger_cancelled',
                  'trip_cancelled',
                  'trip_terminal_cancel',
                  'cancelled_by_admin',
                  'admin_cancelled',
                  'trip_expired_no_driver'
                )
              )
              AND NOT (
                t.driver_id = v_driver_id
                OR t.confirmed_driver_id = v_driver_id
                OR t.previous_driver_id = v_driver_id
                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
              )
              AND (p_before IS NULL OR COALESCE(
                ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at
              ) < p_before)
          ) combined
          ORDER BY combined.id, combined.source_pri ASC, combined.sort_at DESC
        ) deduped
        ORDER BY deduped.sort_at DESC
        LIMIT CASE WHEN p_trip_id IS NOT NULL THEN 1 ELSE v_limit END
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_driver_net_pence_matches_breakdown;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_driver_net_pence_matches_breakdown CHECK (
    (driver_net_pence IS NULL) OR (gross_fare_pence IS NULL) OR (commission_pence IS NULL)
    OR (driver_net_pence = (gross_fare_pence - commission_pence))
  ) NOT VALID;

DROP FUNCTION IF EXISTS public.trip_chargeable_terminal_outcome_kind(text, text, text, integer);
DROP FUNCTION IF EXISTS public.trip_terminal_entitled_driver_id(uuid, uuid, uuid);

COMMIT;
