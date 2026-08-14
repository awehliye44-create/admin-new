-- Dispatch gap close (updated 2026-08-14 pass 2)
-- Includes rematch/CW/maybe_advance/DTO cooldown + DTO max sequences = cycles×3

CREATE OR REPLACE FUNCTION public.driver_cancel_before_start_rematch(p_trip_id uuid, p_driver_id uuid, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_request_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_uid uuid := auth.uid();
  v_jwt_role text := COALESCE(
    NULLIF(auth.role(), ''),
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    'anon'
  );
  v_meta jsonb := COALESCE(p_request_metadata, '{}'::jsonb);
  v_actor_mode text := lower(COALESCE(v_meta->>'actor_mode', ''));
  v_actor text;
  v_auth_driver_id uuid;
  v_status text;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_prev_cancelled uuid[];
  v_next_cancelled uuid[];
  v_prev_excluded uuid[];
  v_next_excluded uuid[];
  v_round_before integer;
  v_round_after integer;
  v_max_offer_round integer;
  v_seq_budget integer;
  v_find_minutes integer;
  v_search_expires timestamptz;
  v_audit_id uuid;
  v_active_offer_id uuid;
  v_customer_active uuid;
  v_finance_before jsonb;
  v_finance_after jsonb;
  v_outbox_key text;
  v_result jsonb;
  v_existing jsonb;
  v_idem_trip uuid;
  v_idem_driver uuid;
  v_outbox_status text;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION',
      'message', 'trip_id and driver_id are required'
    );
  END IF;

  -- Reject explicit no-show routing (never infer from free text alone).
  IF COALESCE((v_meta->>'is_no_show')::boolean, false)
     OR lower(COALESCE(v_meta->>'action_type', '')) IN ('no_show', 'passenger_no_show', 'noshow')
     OR lower(COALESCE(v_meta->>'cancellation_type', '')) IN ('no_show', 'passenger_no_show')
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'NO_SHOW_NOT_ALLOWED',
      'message', 'No-show must use cancel-trip with is_no_show=true; rematch RPC rejects no-show'
    );
  END IF;

  -- Authorise actor
  IF v_jwt_role = 'service_role' THEN
    IF v_actor_mode NOT IN ('service_role', 'edge', 'admin') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'FORBIDDEN',
        'message', 'service_role rematch requires explicit actor_mode in request metadata'
      );
    END IF;
    v_actor := COALESCE(NULLIF(v_meta->>'actor', ''), v_actor_mode);
  ELSIF v_uid IS NOT NULL AND public.has_role(v_uid, 'admin'::public.app_role) THEN
    v_actor := 'admin';
    v_actor_mode := 'admin';
  ELSIF v_uid IS NOT NULL THEN
    SELECT d.id INTO v_auth_driver_id
    FROM public.drivers d
    WHERE d.user_id = v_uid
      AND d.id = p_driver_id
    LIMIT 1;
    IF v_auth_driver_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'FORBIDDEN',
        'message', 'Caller is not authorised for this driver_id'
      );
    END IF;
    v_actor := 'driver';
    v_actor_mode := 'driver';
  ELSE
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'UNAUTHORIZED',
      'message', 'Authentication required'
    );
  END IF;

  -- Lock trip first so concurrent cancel/start/customer-cancel serialize on one row.
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'NOT_FOUND',
      'message', 'Trip not found'
    );
  END IF;

  -- Idempotent replay check (after trip lock; claim happens only after validation).
  -- Keys are trip-scoped: reuse against a different trip_id/driver_id is rejected.
  IF v_idem IS NOT NULL THEN
    SELECT result, trip_id, driver_id
      INTO v_existing, v_idem_trip, v_idem_driver
    FROM public.driver_cancel_rematch_idempotency
    WHERE idempotency_key = v_idem
    FOR UPDATE;

    IF FOUND THEN
      IF v_idem_trip IS DISTINCT FROM p_trip_id THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Idempotency key already used for a different trip'
        );
      END IF;
      IF v_idem_driver IS DISTINCT FROM p_driver_id THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Idempotency key already used for a different driver'
        );
      END IF;
      IF COALESCE((v_existing->>'pending')::boolean, false) THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Rematch already in progress for this idempotency key'
        );
      END IF;
      RETURN COALESCE(v_existing, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  v_status := lower(COALESCE(v_trip.status, ''));

  -- Already rematched for this driver (CAS soft idempotency without prior key).
  -- Ensure a retryable outbox row exists so Edge does not skip rebroadcast forever.
  IF v_status = 'searching_new_driver'
     AND v_trip.confirmed_driver_id IS NULL
     AND (
       p_driver_id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[]))
       OR EXISTS (
         SELECT 1 FROM public.trip_driver_exclusions tde
         WHERE tde.trip_id = p_trip_id AND tde.driver_id = p_driver_id
           AND tde.source = 'driver_cancel_before_start'
       )
     )
  THEN
    -- auto-dispatch owns round increment; rematch only records the stored round.
    v_round_after := COALESCE(v_trip.current_broadcast_round, 0);
    v_outbox_key := COALESCE(
      v_idem,
      format(
        'driver_cancel_before_pickup:%s:%s:r%s',
        p_trip_id,
        p_driver_id,
        v_round_after
      )
    );

    INSERT INTO public.dispatch_intent_outbox (
      trip_id, intent, trigger_reason, idempotency_key, status, payload
    ) VALUES (
      p_trip_id,
      'auto_dispatch_rebroadcast',
      'driver_cancel_before_pickup',
      v_outbox_key,
      'pending',
      jsonb_build_object(
        'force_rebroadcast', true,
        'driver_id', p_driver_id,
        'soft_idempotent', true,
        'broadcast_round', v_round_after
      )
    )
    ON CONFLICT (idempotency_key) DO UPDATE
    SET
      status = CASE
        WHEN public.dispatch_intent_outbox.status = 'done' THEN public.dispatch_intent_outbox.status
        ELSE 'pending'
      END,
      last_error = CASE
        WHEN public.dispatch_intent_outbox.status = 'done' THEN public.dispatch_intent_outbox.last_error
        ELSE NULL
      END
    WHERE public.dispatch_intent_outbox.status IS DISTINCT FROM 'done';

    SELECT status INTO v_outbox_status
    FROM public.dispatch_intent_outbox
    WHERE idempotency_key = v_outbox_key;

    v_result := jsonb_build_object(
      'ok', true,
      'outcome', 'rematch',
      'trip_id', p_trip_id,
      'previous_status', v_trip.status,
      'status', 'searching_new_driver',
      'dispatch_status', COALESCE(v_trip.dispatch_status, 'broadcasting'),
      'driver_cleared', true,
      'driver_excluded', true,
      'payment_action', 'unchanged',
      'idempotent_replay', true,
      'current_broadcast_round', v_round_after,
      'dispatch_outbox_key', v_outbox_key,
      'dispatch_outbox_status', v_outbox_status,
      'finance_unchanged', true,
      'customer_active_trip_preserved', true
    );
    IF v_idem IS NOT NULL THEN
      INSERT INTO public.driver_cancel_rematch_idempotency (
        idempotency_key, trip_id, driver_id, result
      ) VALUES (v_idem, p_trip_id, p_driver_id, v_result)
      ON CONFLICT (idempotency_key) DO UPDATE
      SET result = EXCLUDED.result
      WHERE public.driver_cancel_rematch_idempotency.trip_id = p_trip_id
        AND public.driver_cancel_rematch_idempotency.driver_id = p_driver_id;
    END IF;
    RETURN v_result;
  END IF;

  IF v_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'FORBIDDEN',
      'message', 'Requesting driver is not the current assignment SSOT'
    );
  END IF;

  IF public.is_driver_cancel_rematch_rejected_status(v_status)
     OR NOT public.is_driver_cancel_rematch_eligible_status(v_status)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_STATE',
      'message', format('Status %s is not rematchable for driver cancel before start', COALESCE(v_trip.status, 'null'))
    );
  END IF;

  IF v_trip.started_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_STATE',
      'message', 'Trip already started — rematch not allowed'
    );
  END IF;

  -- Claim idempotency key only after validation (trip lock serializes same-trip callers).
  IF v_idem IS NOT NULL THEN
    INSERT INTO public.driver_cancel_rematch_idempotency (
      idempotency_key, trip_id, driver_id, result
    ) VALUES (
      v_idem, p_trip_id, p_driver_id,
      jsonb_build_object('ok', null, 'pending', true)
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    SELECT result, trip_id, driver_id
      INTO v_existing, v_idem_trip, v_idem_driver
    FROM public.driver_cancel_rematch_idempotency
    WHERE idempotency_key = v_idem
    FOR UPDATE;

    IF FOUND THEN
      IF v_idem_trip IS DISTINCT FROM p_trip_id
         OR v_idem_driver IS DISTINCT FROM p_driver_id
      THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Idempotency key already used for a different trip/driver'
        );
      END IF;
      IF NOT COALESCE((v_existing->>'pending')::boolean, false) THEN
        RETURN COALESCE(v_existing, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
      END IF;
    END IF;
  END IF;

  -- Snapshot finance identity (must remain unchanged)
  v_finance_before := jsonb_build_object(
    'fare', v_trip.fare,
    'fare_amount', v_trip.fare_amount,
    'estimated_fare', v_trip.estimated_fare,
    'estimated_total_pence', v_trip.estimated_total_pence,
    'gross_fare_pence', v_trip.gross_fare_pence,
    'final_fare_pence', v_trip.final_fare_pence,
    'final_customer_fare_pence', v_trip.final_customer_fare_pence,
    'discount_pence', v_trip.discount_pence,
    'voucher_discount_pence', v_trip.voucher_discount_pence,
    'offer_discount_pence', v_trip.offer_discount_pence,
    'payment_intent_id', v_trip.payment_intent_id,
    'payment_status', v_trip.payment_status,
    'payment_state', v_trip.payment_state,
    'payment_method', v_trip.payment_method,
    'provider_order_id', v_trip.provider_order_id,
    'applied_offer_id', v_trip.applied_offer_id,
    'applied_personal_voucher_id', v_trip.applied_personal_voucher_id,
    'passenger_id', v_trip.passenger_id
  );

  SELECT active_trip_id INTO v_customer_active
  FROM public.customers
  WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id
  LIMIT 1;

  v_round_before := COALESCE(v_trip.current_broadcast_round, 0);
  SELECT COALESCE(MAX(ro.broadcast_round), 0) INTO v_max_offer_round
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id;
  -- Fresh rematch attempt: align to end of current 3-wave cycle so the next
  -- auto-dispatch sequence is W1 (UNIQUE trip+driver+broadcast_round safe).
  -- Commission floor resets; accepted snapshot cleared for the new attempt.
  v_round_after := ((GREATEST(v_round_before, v_max_offer_round) + 2) / 3) * 3;
  SELECT public.dispatch_max_broadcast_rounds(
    public.get_dispatch_settings(v_trip.service_area_id),
    NULL
  ) INTO v_seq_budget;
  v_seq_budget := GREATEST(3, COALESCE(v_seq_budget, 9));

  v_prev_cancelled := COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[]);
  IF p_driver_id = ANY (v_prev_cancelled) THEN
    v_next_cancelled := v_prev_cancelled;
  ELSE
    v_next_cancelled := array_append(v_prev_cancelled, p_driver_id);
  END IF;

  v_prev_excluded := COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[]);
  v_next_excluded := (
    SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[])
    FROM unnest(v_prev_excluded || v_next_cancelled) AS x
  );

  SELECT ds.max_driver_find_time_minutes
    INTO v_find_minutes
  FROM public.get_dispatch_settings(v_trip.service_area_id) ds;
  v_find_minutes := COALESCE(NULLIF(v_find_minutes, 0), 3);
  v_search_expires := v_now + make_interval(mins => v_find_minutes);

  SELECT ro.id INTO v_active_offer_id
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.driver_id = p_driver_id
    AND ro.status IN ('pending', 'accepted', 'countered')
  ORDER BY ro.offered_at DESC NULLS LAST
  LIMIT 1;

  INSERT INTO public.driver_cancel_rematch_audit (
    trip_id, driver_id, previous_status, resulting_status, reason,
    actor, actor_mode, idempotency_key, request_metadata,
    broadcast_round_before, broadcast_round_after
  ) VALUES (
    p_trip_id, p_driver_id, v_trip.status, 'searching_new_driver',
    COALESCE(v_reason, 'driver_cancelled'),
    v_actor, v_actor_mode, v_idem, v_meta,
    v_round_before, v_round_after
  )
  RETURNING id INTO v_audit_id;

  INSERT INTO public.trip_driver_exclusions (
    trip_id, driver_id, reason, offer_id, source, audit_event_id, metadata, created_at
  ) VALUES (
    p_trip_id,
    p_driver_id,
    COALESCE(v_reason, 'driver_cancelled'),
    v_active_offer_id,
    'driver_cancel_before_start',
    v_audit_id,
    jsonb_build_object(
      'previous_status', v_trip.status,
      'actor', v_actor,
      'actor_mode', v_actor_mode,
      'idempotency_key', v_idem
    ),
    v_now
  )
  ON CONFLICT (trip_id, driver_id) DO UPDATE
  SET
    reason = EXCLUDED.reason,
    offer_id = COALESCE(EXCLUDED.offer_id, public.trip_driver_exclusions.offer_id),
    source = 'driver_cancel_before_start',
    audit_event_id = COALESCE(EXCLUDED.audit_event_id, public.trip_driver_exclusions.audit_event_id),
    metadata = COALESCE(public.trip_driver_exclusions.metadata, '{}'::jsonb) || EXCLUDED.metadata;

  UPDATE public.ride_offers
  SET
    status = 'revoked',
    revoked_reason = 'driver_cancelled_before_pickup',
    updated_at = v_now
  WHERE trip_id = p_trip_id
    AND status IN ('pending', 'accepted', 'countered');

  UPDATE public.trips
  SET
    status = 'searching_new_driver',
    dispatch_status = 'broadcasting',
    driver_id = NULL,
    confirmed_driver_id = NULL,
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    negotiation_owner_driver_id = NULL,
    negotiation_status = NULL,
    negotiation_locked_until = NULL,
    accepted_ride_offer_id = NULL,
    assigned_at = NULL,
    arrived_at = NULL,
    pickup_arrived_at = NULL,
    scheduled_accepted_at = NULL,
    pickup_waiting_started_at = NULL,
    pickup_paid_waiting_started_at = NULL,
    paid_waiting_started_at = NULL,
    free_wait_expires_at = NULL,
    driver_location_lat = NULL,
    driver_location_lng = NULL,
    driver_started_journey_to_pickup_at = NULL,
    confirm_deadline_at = NULL,
    driver_confirm_deadline_at = NULL,
    commitment_time = NULL,
    previous_driver_id = p_driver_id,
    cancelled_driver_ids = v_next_cancelled,
    excluded_driver_ids = v_next_excluded,
    broadcast_enabled = true,
    cancelled_by = 'driver',
    cancel_reason = 'driver_cancelled',
    current_broadcast_round = v_round_after,
    max_wave_commission_reduction_percent = 0,
    accepted_commission_percent = NULL,
    accepted_dispatch_wave = NULL,
    accepted_dispatch_round = NULL,
    driver_tier_commission_percent = NULL,
    commission_pct = NULL,
    max_broadcast_rounds = GREATEST(
      COALESCE(v_trip.max_broadcast_rounds, 0),
      v_round_after + v_seq_budget
    ),
    searching_expires_at = v_search_expires,
    updated_at = v_now
  WHERE id = p_trip_id
    AND confirmed_driver_id = p_driver_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFLICT: trip assignment changed during rematch'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.drivers
  SET current_trip_id = NULL, updated_at = v_now
  WHERE id = p_driver_id
    AND current_trip_id = p_trip_id;

  -- Preserve customer active trip attachment:
  -- never clear; never overwrite a different active trip; attach only if null/same.
  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers
    SET
      active_trip_id = COALESCE(active_trip_id, p_trip_id),
      updated_at = v_now
    WHERE (id = v_trip.passenger_id OR user_id = v_trip.passenger_id)
      AND (active_trip_id IS NULL OR active_trip_id = p_trip_id);

    -- Proof: when customer was already on this trip (or unset), attachment must remain.
    IF v_customer_active IS NULL OR v_customer_active = p_trip_id THEN
      SELECT active_trip_id INTO v_customer_active
      FROM public.customers
      WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id
      LIMIT 1;

      IF v_customer_active IS DISTINCT FROM p_trip_id THEN
        RAISE EXCEPTION 'CUSTOMER_ACTIVE_TRIP_CHANGED: rematch must preserve customers.active_trip_id'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  SELECT jsonb_build_object(
    'fare', t.fare,
    'fare_amount', t.fare_amount,
    'estimated_fare', t.estimated_fare,
    'estimated_total_pence', t.estimated_total_pence,
    'gross_fare_pence', t.gross_fare_pence,
    'final_fare_pence', t.final_fare_pence,
    'final_customer_fare_pence', t.final_customer_fare_pence,
    'discount_pence', t.discount_pence,
    'voucher_discount_pence', t.voucher_discount_pence,
    'offer_discount_pence', t.offer_discount_pence,
    'payment_intent_id', t.payment_intent_id,
    'payment_status', t.payment_status,
    'payment_state', t.payment_state,
    'payment_method', t.payment_method,
    'provider_order_id', t.provider_order_id,
    'applied_offer_id', t.applied_offer_id,
    'applied_personal_voucher_id', t.applied_personal_voucher_id,
    'passenger_id', t.passenger_id
  )
  INTO v_finance_after
  FROM public.trips t
  WHERE t.id = p_trip_id;

  IF v_finance_before IS DISTINCT FROM v_finance_after THEN
    RAISE EXCEPTION 'FINANCE_MUTATION_FORBIDDEN: rematch must not alter fare/payment/voucher identity'
      USING ERRCODE = 'P0001';
  END IF;

  v_outbox_key := COALESCE(
    v_idem,
    format('driver_cancel_before_pickup:%s:%s:r%s', p_trip_id, p_driver_id, v_round_after)
  );

  INSERT INTO public.dispatch_intent_outbox (
    trip_id, intent, trigger_reason, idempotency_key, status, payload
  ) VALUES (
    p_trip_id,
    'auto_dispatch_rebroadcast',
    'driver_cancel_before_pickup',
    v_outbox_key,
    'pending',
    jsonb_build_object(
      'force_rebroadcast', true,
      'driver_id', p_driver_id,
      'audit_event_id', v_audit_id,
      'broadcast_round', v_round_after
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.dispatch_audit_log (trip_id, event_type, round, driver_id, details)
  VALUES (
    p_trip_id,
    'driver_cancel_before_start_rematch',
    v_round_after,
    p_driver_id,
    jsonb_build_object(
      'previous_status', v_status,
      'status', 'searching_new_driver',
      'dispatch_status', 'broadcasting',
      'actor', v_actor,
      'actor_mode', v_actor_mode,
      'audit_event_id', v_audit_id,
      'customer_active_trip_before', v_customer_active,
      'finance_unchanged', true
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'outcome', 'rematch',
    'trip_id', p_trip_id,
    'previous_status', v_trip.status,
    'status', 'searching_new_driver',
    'dispatch_status', 'broadcasting',
    'driver_cleared', true,
    'driver_excluded', true,
    'payment_action', 'unchanged',
    'idempotent_replay', false,
    'current_broadcast_round', v_round_after,
    'searching_expires_at', v_search_expires,
    'audit_event_id', v_audit_id,
    'dispatch_outbox_key', v_outbox_key,
    'finance_unchanged', true,
    'customer_active_trip_preserved', true
  );

  IF v_idem IS NOT NULL THEN
    UPDATE public.driver_cancel_rematch_idempotency
    SET result = v_result
    WHERE idempotency_key = v_idem;
  END IF;

  RETURN v_result;
END;
$function$


CREATE OR REPLACE FUNCTION public.convert_driver_commission_wallet_on_trip_complete(p_driver_id uuid, p_trip_id uuid, p_commission_minor integer DEFAULT NULL::integer, p_commissionable_fare_minor integer DEFAULT NULL::integer, p_commission_rate_bps integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_sa public.service_areas%ROWTYPE;
  v_existing_deduction_id uuid;
  v_fare_minor integer;
  v_airport integer;
  v_pass_through integer;
  v_commissionable integer;
  v_rate_bps integer;
  v_pct numeric;
  v_earned integer;
  v_parts record;
  v_promo integer;
  v_purchased integer;
  v_from_promo integer;
  v_from_purchased integer;
  v_currency text;
  v_deduction_idempotency text;
  v_deduction_ledger_id uuid;
  v_trip_code text;
  v_balance_before integer;
BEGIN
  IF p_driver_id IS NULL OR p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'skipped', true, 'code', 'INVALID_ARGS');
  END IF;

  PERFORM 1 FROM public.drivers WHERE id = p_driver_id FOR UPDATE;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'TRIP_NOT_FOUND', 'error', 'Trip not found');
  END IF;

  -- Prefer persisted trip payment model; fall back to current SA only when snapshot absent.
  IF NOT public.trip_row_is_commission_wallet_driver_collected(v_trip) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', true, 'code', 'WALLET_GATE_OFF');
  END IF;

  IF v_trip.service_area_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_AREA_MISSING', 'error', 'Trip has no service area');
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = v_trip.service_area_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_AREA_NOT_FOUND', 'error', 'Service area not found');
  END IF;

  SELECT id INTO v_existing_deduction_id
  FROM public.driver_commission_wallet_ledger
  WHERE trip_id = p_trip_id
    AND entry_type = 'COMMISSION_DEDUCTION'
  LIMIT 1;

  IF v_existing_deduction_id IS NOT NULL THEN
    UPDATE public.driver_commission_wallet_reserves
    SET status = 'legacy_reservation_voided', updated_at = now()
    WHERE driver_id = p_driver_id
      AND trip_id = p_trip_id
      AND status = 'active';

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_existing_deduction_id,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  UPDATE public.driver_commission_wallet_reserves
  SET
    status = 'legacy_reservation_voided',
    updated_at = now(),
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'legacy_void_reason', 'voided_on_completion_no_pretrip_reserve',
      'voided_at', now()
    )
  WHERE driver_id = p_driver_id
    AND trip_id = p_trip_id
    AND status = 'active';

  IF p_commission_minor IS NOT NULL THEN
    v_earned := GREATEST(0, p_commission_minor);
  ELSE
    v_fare_minor := GREATEST(
      0,
      COALESCE(
        NULLIF(v_trip.final_customer_fare_pence, 0),
        NULLIF(v_trip.final_fare_pence, 0),
        public.trip_commission_reserve_fare_minor(v_trip)
      )
    );
    v_airport := GREATEST(0, COALESCE(v_trip.airport_charge_pence, 0));
    v_pass_through := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));
    v_commissionable := GREATEST(
      0,
      COALESCE(NULLIF(p_commissionable_fare_minor, 0), v_fare_minor - v_airport - v_pass_through)
    );
    v_pct := COALESCE(
      NULLIF(v_trip.accepted_commission_percent, 0),
      NULLIF(v_trip.driver_tier_commission_percent, 0),
      public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id),
      0
    );
    v_rate_bps := GREATEST(
      0,
      COALESCE(
        NULLIF(p_commission_rate_bps, 0),
        NULLIF(v_trip.snapshotted_commission_rate_bps, 0),
        ROUND(v_pct * 100)::integer
      )
    );
    v_earned := public.required_commission_reserve_minor(v_commissionable, v_rate_bps);
  END IF;

  IF v_earned <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'skipped', true,
      'code', 'ZERO_COMMISSION',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  SELECT * INTO v_parts
  FROM public.driver_commission_wallet_balance_parts(p_driver_id, v_trip.service_area_id);

  v_balance_before := COALESCE(v_parts.usable_commission_balance_minor, 0);
  v_promo := COALESCE(v_parts.promotional_balance_minor, 0);
  v_purchased := COALESCE(v_parts.purchased_balance_minor, 0);

  v_from_promo := LEAST(v_earned, GREATEST(0, v_promo));
  v_from_purchased := v_earned - v_from_promo;

  v_currency := UPPER(COALESCE(
    NULLIF(v_sa.commission_wallet_currency, ''),
    NULLIF(v_sa.currency_code, ''),
    NULLIF(v_trip.snapshotted_commission_currency, ''),
    'USD'
  ));

  v_trip_code := NULLIF(btrim(COALESCE(v_trip.trip_code, '')), '');
  v_deduction_idempotency := left('cw_deduction_' || p_trip_id::text, 180);

  INSERT INTO public.driver_commission_wallet_ledger (
    driver_id, service_area_id, region_id, currency, entry_type, amount_minor, direction,
    trip_id, reason, promotional_portion_minor, purchased_portion_minor, idempotency_key, metadata
  ) VALUES (
    p_driver_id, v_trip.service_area_id, v_sa.region_id, v_currency,
    'COMMISSION_DEDUCTION', v_earned, 'debit', p_trip_id,
    'Completed-trip commission deduction',
    v_from_promo, v_from_purchased, v_deduction_idempotency,
    jsonb_build_object(
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION',
      'phase', 'no_pretrip_reserve',
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'trip_id', p_trip_id,
      'public_trip_id', v_trip_code,
      'trip_code', v_trip_code,
      'driver_id', p_driver_id,
      'service_area_id', v_trip.service_area_id,
      'final_fare_minor', COALESCE(v_fare_minor, v_commissionable),
      'commissionable_fare_minor', COALESCE(p_commissionable_fare_minor, v_commissionable),
      'commission_rate_bps', COALESCE(p_commission_rate_bps, v_rate_bps),
      'commission_amount_minor', v_earned,
      'currency', v_currency,
      'completion_at', now(),
      'balance_before_minor', v_balance_before,
      'balance_after_minor', v_balance_before - v_earned,
      'allows_negative', true
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_deduction_ledger_id;

  IF v_deduction_ledger_id IS NULL THEN
    SELECT id INTO v_deduction_ledger_id
    FROM public.driver_commission_wallet_ledger
    WHERE idempotency_key = v_deduction_idempotency;

    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
  END IF;

  UPDATE public.trips
  SET
    financial_model = COALESCE(financial_model, 'DRIVER_COLLECTED_COMMISSION_WALLET'),
    commission_wallet_enabled = COALESCE(commission_wallet_enabled, true),
    snapshotted_commission_rate_bps = COALESCE(
      NULLIF(snapshotted_commission_rate_bps, 0),
      COALESCE(p_commission_rate_bps, v_rate_bps)
    ),
    snapshotted_commission_currency = COALESCE(
      NULLIF(snapshotted_commission_currency, ''),
      v_currency
    ),
    updated_at = now()
  WHERE id = p_trip_id
    AND public.is_commission_wallet_workflow_enabled(service_area_id);

  RETURN jsonb_build_object(
    'ok', true,
    'ledger_entry_id', v_deduction_ledger_id,
    'amount_minor', v_earned,
    'commission_earned_minor', v_earned,
    'shortfall_minor', GREATEST(0, v_earned - GREATEST(v_balance_before, 0)),
    'forced_overdraft', v_balance_before < v_earned,
    'promotional_portion_minor', v_from_promo,
    'purchased_portion_minor', v_from_purchased,
    'balance_before_minor', v_balance_before,
    'balance_after_minor', v_balance_before - v_earned,
    'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
    'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT id, amount_minor INTO v_deduction_ledger_id, v_earned
    FROM public.driver_commission_wallet_ledger
    WHERE trip_id = p_trip_id AND entry_type = 'COMMISSION_DEDUCTION'
    LIMIT 1;
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'code', 'ALREADY_DEDUCTED',
      'ledger_entry_id', v_deduction_ledger_id,
      'amount_minor', v_earned,
      'revenue_source', 'COMMISSION_WALLET_DEDUCTION',
      'transaction_type', 'TRIP_COMMISSION_DEDUCTION'
    );
END;
$function$


CREATE OR REPLACE FUNCTION public.maybe_advance_dispatch_after_offer_resolution(p_trip_id uuid, p_resolved_driver_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_cancelled uuid[];
  v_excluded uuid[];
  v_pending_count int;
  v_seq int;
  v_max_seq int;
  v_max_rounds int;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL OR v_trip.confirmed_driver_id IS NOT NULL THEN
    RETURN;
  END IF;

  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN;
  END IF;

  IF v_trip.status IN ('completed', 'cancelled', 'declined') THEN
    RETURN;
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL AND v_trip.status = 'negotiating' THEN
    RETURN;
  END IF;

  -- Soft decline/timeout resolution must NOT permanently exclude the driver.
  -- Permanent exclusion is owned by rematch cancel + finalize_negotiation_failure.
  -- Edge auto-dispatch applies cooldown_after_reject_seconds for soft declines.
  NULL;

  SELECT count(*)::int INTO v_pending_count
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.status IN ('pending', 'countered')
    AND (
      ro.negotiation_status IN ('waiting_customer', 'waiting_driver', 'waiting_driver_final')
      OR ro.expires_at IS NULL
      OR ro.expires_at > v_now
    );

  IF v_pending_count > 0 THEN
    UPDATE public.trips
    SET status = 'offered',
        dispatch_status = 'broadcasting',
        driver_id = NULL,
        confirmed_driver_id = NULL,
        negotiation_owner_driver_id = NULL,
        negotiation_locked_until = NULL,
        updated_at = v_now
    WHERE id = p_trip_id
      AND status IN (
        'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
      );
    RETURN;
  END IF;

  v_seq := COALESCE(v_trip.current_broadcast_round, 0);
  v_max_seq := public.dispatch_max_broadcast_rounds(
    public.get_dispatch_settings(v_trip.service_area_id),
    v_trip.max_broadcast_rounds
  );

  IF v_seq >= v_max_seq THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN;
  END IF;

  UPDATE public.trips
  SET status = 'searching',
      dispatch_status = 'broadcasting',
      updated_at = v_now
  WHERE id = p_trip_id
    AND status IN (
      'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
    );
END;
$function$


CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip record;
  v_settings record;
  v_round int;
  v_max_rounds int;
  v_offer_expiry_seconds int;
  v_search_radius_meters int;
  v_max_offers_per_request int;
  v_expires_at timestamptz;
  v_now timestamptz := now();
  v_presence_max_age_seconds int := 60;
BEGIN
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_trip.status IS NULL OR v_trip.status NOT IN (
    'pending','searching','broadcasting','offered','offering','searching_new_driver'
  ) THEN
    RETURN;
  END IF;

  IF v_trip.status IN ('completed','cancelled','expired','declined') THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id
      AND ro.status IN ('pending','accepted')
      AND ro.expires_at > v_now
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO v_settings
  FROM public.dispatch_settings
  WHERE service_area_id = v_trip.service_area_id
  LIMIT 1;

  IF v_settings IS NULL THEN
    SELECT * INTO v_settings
    FROM public.dispatch_settings
    WHERE service_area_id IS NULL
    LIMIT 1;
  END IF;

  v_search_radius_meters := COALESCE(v_settings.search_radius_meters, 5000);
  v_offer_expiry_seconds := COALESCE(v_settings.offer_expiry_seconds, 20);
  v_max_offers_per_request := COALESCE(v_settings.max_offers_per_request, 5);

  v_round := COALESCE(v_trip.current_broadcast_round, 0) + 1;
  v_max_rounds := public.dispatch_max_broadcast_rounds(
    public.get_dispatch_settings(v_trip.service_area_id),
    v_trip.max_broadcast_rounds
  );

  IF v_round > v_max_rounds THEN
    UPDATE public.trips
    SET status = 'expired',
        dispatch_status = 'expired',
        updated_at = v_now
    WHERE id = p_trip_id;
    RETURN;
  END IF;

  v_expires_at := v_now + make_interval(secs => v_offer_expiry_seconds);

  INSERT INTO public.ride_offers (trip_id, driver_id, status, expires_at, distance_meters, broadcast_round, offered_at)
  SELECT
    p_trip_id,
    d.id,
    'pending',
    v_expires_at,
    round(public.haversine_meters(
      v_trip.pickup_latitude,
      v_trip.pickup_longitude,
      COALESCE(dp.lat, d.current_lat),
      COALESCE(dp.lng, d.current_lng)
    ))::int,
    v_round,
    v_now
  FROM public.drivers d
  JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.is_online = true
    AND d.approval_status = 'approved'
    AND d.current_trip_id IS NULL
    AND dp.status = 'online'
    AND dp.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age_seconds)
    AND dp.push_token IS NOT NULL
    AND dp.push_token <> ''
    AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
    AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
    AND NOT public.driver_location_is_frozen(d.id)
    AND (
      v_trip.service_area_id IS NULL
      OR d.service_area_id = v_trip.service_area_id
      OR EXISTS (
        SELECT 1 FROM public.driver_service_areas dsa
        WHERE dsa.driver_id = d.id
          AND dsa.service_area_id = v_trip.service_area_id
      )
    )
    AND (v_trip.region_id IS NULL OR d.region_id = v_trip.region_id)
    AND public.haversine_meters(
      v_trip.pickup_latitude,
      v_trip.pickup_longitude,
      COALESCE(dp.lat, d.current_lat),
      COALESCE(dp.lng, d.current_lng)
    ) <= v_search_radius_meters
    AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
    AND NOT EXISTS (
      SELECT 1 FROM public.ride_offers ro
      WHERE ro.trip_id = p_trip_id
        AND ro.driver_id = d.id
        AND ro.status IN ('pending','accepted','revoked')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ride_offers ro
      WHERE ro.trip_id = p_trip_id
        AND ro.driver_id = d.id
        AND ro.status = 'declined'
        AND COALESCE(ro.responded_at, ro.updated_at, ro.offered_at) >
            (v_now - make_interval(secs => COALESCE(
              (public.get_dispatch_settings(v_trip.service_area_id)).cooldown_after_reject_seconds,
              180
            )))
    )
  ORDER BY public.haversine_meters(
    v_trip.pickup_latitude,
    v_trip.pickup_longitude,
    COALESCE(dp.lat, d.current_lat),
    COALESCE(dp.lng, d.current_lng)
  ) ASC
  LIMIT v_max_offers_per_request;

  UPDATE public.trips
  SET status = 'offered',
      dispatch_status = 'broadcasting',
      current_broadcast_round = v_round,
      broadcast_started_at = COALESCE(v_trip.broadcast_started_at, v_now),
      last_broadcast_at = v_now,
      updated_at = v_now
  WHERE id = p_trip_id;
END;
$function$

CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_internal boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$

DECLARE
  v_trip record;
  v_settings public.dispatch_settings;
  v_round int;
  v_max_rounds int;
  v_offer_expiry_seconds int;
  v_search_radius_meters int;
  v_wave_cap int;
  v_shortlist_limit int;
  v_expires_at timestamptz;
  v_now timestamptz := now();
  v_presence_max_age_seconds int := 60;
  v_inserted int;
  v_cooldown_seconds int;
  v_emergency_only boolean;

BEGIN
  -- P0 #1: amount gate before any ride_offer insert (boolean overload).
  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION '%', SQLERRM USING ERRCODE = 'P0001';
  END;

  IF NOT p_internal THEN

    SELECT COALESCE(ds.manual_emergency_dispatch_only, false)
      INTO v_emergency_only
      FROM public.dispatch_settings ds
     WHERE ds.service_area_id IS NULL
     LIMIT 1;
    IF NOT COALESCE(v_emergency_only, false) THEN
      RAISE EXCEPTION
        'dispatch_trip_offers RPC disabled (Phase 3). Use auto-dispatch edge. Enable manual_emergency_dispatch_only on global dispatch_settings for admin emergency SQL dispatch.';
    END IF;
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_settings := public.get_dispatch_settings(v_trip.service_area_id);

  -- Pause SQL dispatch while broadcast is disabled.
  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN;
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL OR v_trip.status = 'negotiating' THEN
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN;
  END IF;

  IF v_trip.status IS NULL OR v_trip.status NOT IN (
    'pending', 'searching', 'broadcasting', 'offered', 'offering', 'searching_new_driver'
  ) THEN
    RETURN;
  END IF;

  IF v_trip.status IN ('completed', 'cancelled', 'expired', 'declined') THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id
      AND ro.status IN ('pending', 'accepted', 'countered')
      AND (
        ro.negotiation_status IN ('waiting_customer', 'waiting_driver', 'waiting_driver_final')
        OR ro.expires_at > v_now
      )
  ) THEN
    RETURN;
  END IF;

  v_cooldown_seconds := COALESCE(v_settings.cooldown_after_reject_seconds, 180);
  v_round := COALESCE(v_trip.current_broadcast_round, 0) + 1;
  v_max_rounds := public.dispatch_max_broadcast_rounds(v_settings, v_trip.max_broadcast_rounds);
  v_search_radius_meters := public.dispatch_effective_radius_meters(v_settings, v_round);
  v_wave_cap := public.dispatch_wave_cap(v_settings, v_round);
  v_shortlist_limit := COALESCE(v_settings.shortlist_limit, 100);
  v_offer_expiry_seconds := public.dispatch_wave_offer_expiry_seconds(v_settings, v_round);

  IF v_round > v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN;
  END IF;

  v_expires_at := v_now + make_interval(secs => v_offer_expiry_seconds);

  INSERT INTO public.ride_offers (
    trip_id, driver_id, status, expires_at, distance_meters, broadcast_round, offered_at, offer_snapshot
  )
  SELECT
    p_trip_id,
    cand.driver_id,
    'pending',
    v_expires_at,
    cand.distance_meters,
    v_round,
    v_now,
    jsonb_build_object('dispatch_source', 'sql_dispatch_trip_offers')
  FROM (
    SELECT
      d.id AS driver_id,
      round(public.haversine_meters(
        v_trip.pickup_latitude,
        v_trip.pickup_longitude,
        COALESCE(dp.lat, d.current_lat),
        COALESCE(dp.lng, d.current_lng)
      ))::int AS distance_meters,
      public.compute_dispatch_score(
        v_settings,
        public.haversine_meters(
          v_trip.pickup_latitude,
          v_trip.pickup_longitude,
          COALESCE(dp.lat, d.current_lat),
          COALESCE(dp.lng, d.current_lng)
        ),
        COALESCE(d.display_rating, d.rating, 4.5),
        COALESCE(
          (
            SELECT COUNT(*) FILTER (WHERE ro2.status = 'accepted')::numeric
              / NULLIF(COUNT(*)::numeric, 0)
            FROM public.ride_offers ro2
            WHERE ro2.driver_id = d.id
              AND ro2.created_at > v_now - interval '30 days'
          ),
          0.5
        ),
        public.driver_idle_minutes(d.last_trip_end_at, d.online_since, d.last_seen_at, v_now)
      ) AS dispatch_score
    FROM public.drivers d
    JOIN public.driver_presence dp ON dp.driver_id = d.id
    WHERE d.is_online = true
      AND d.approval_status = 'approved'
      AND d.current_trip_id IS NULL
      AND dp.status = 'online'
      AND dp.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age_seconds)
      AND dp.push_token IS NOT NULL
      AND dp.push_token <> ''
      AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
      AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
      AND NOT public.driver_location_is_frozen(d.id)
      AND COALESCE(d.display_rating, d.rating, 0) >= COALESCE(v_settings.minimum_rating, 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
      AND NOT EXISTS (
        SELECT 1 FROM public.trip_driver_exclusions tde
        WHERE tde.trip_id = p_trip_id
          AND tde.driver_id = d.id
      )
      AND (
        v_trip.service_area_id IS NULL
        OR d.service_area_id = v_trip.service_area_id
        OR EXISTS (
          SELECT 1 FROM public.driver_service_areas dsa
          WHERE dsa.driver_id = d.id
            AND dsa.service_area_id = v_trip.service_area_id
        )
      )
      AND (v_trip.region_id IS NULL OR d.region_id = v_trip.region_id)
      AND public.haversine_meters(
        v_trip.pickup_latitude,
        v_trip.pickup_longitude,
        COALESCE(dp.lat, d.current_lat),
        COALESCE(dp.lng, d.current_lng)
      ) <= v_search_radius_meters
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id
          AND ro.driver_id = d.id
          -- Do not block rematch rebroadcast on historically revoked offers.
          -- Soft declines use cooldown below (Edge parity); do not hard-block forever.
          AND ro.status IN ('pending', 'accepted', 'countered')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id
          AND ro.driver_id = d.id
          AND ro.status IN ('declined', 'expired')
          AND ro.responded_at > v_now - make_interval(secs => v_cooldown_seconds)
      )
      AND public.driver_passes_commission_wallet_dispatch_gate(d.id, p_trip_id)
    ORDER BY dispatch_score DESC, distance_meters ASC
    LIMIT v_shortlist_limit
  ) cand
  LIMIT v_wave_cap;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    UPDATE public.trips
    SET
      current_broadcast_round = v_round,
      last_broadcast_at = v_now,
      updated_at = v_now
    WHERE id = p_trip_id;
    PERFORM public.maybe_advance_dispatch_after_offer_resolution(p_trip_id, NULL);
    RETURN;
  END IF;

  UPDATE public.trips
  SET status = 'offered',
      dispatch_status = 'broadcasting',
      current_broadcast_round = v_round,
      broadcast_started_at = COALESCE(v_trip.broadcast_started_at, v_now),
      last_broadcast_at = v_now,
      updated_at = v_now
  WHERE id = p_trip_id;

  PERFORM public.enrich_ride_offer_presets(p_trip_id);
END;

$function$

CREATE OR REPLACE FUNCTION public.dispatch_trip_offers(p_trip_id uuid, p_trigger_reason text DEFAULT 'auto'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip            public.trips%ROWTYPE;
  v_g               public.global_dispatch_settings%ROWTYPE;
  v_now             timestamptz := now();
  v_seq             integer;
  v_wave            integer;
  v_round           integer;
  v_max_rounds      integer;
  v_wave_cap        integer;
  v_radius          integer;
  v_max_radius      integer;
  v_expiry_secs     integer;
  v_presence_max_age int;
  v_inserted        integer := 0;
  v_candidate_count int := 0;
  v_eligible_count  int := 0;
  v_degraded_count  int := 0;
  v_hard_excl_count int := 0;
  v_selected_count  int := 0;
  v_selected_json   jsonb := '[]'::jsonb;
  v_previous_json   jsonb := '[]'::jsonb;
  v_prev_seq        integer;
  v_offer_ids       uuid[] := ARRAY[]::uuid[];
  v_selected_ids    uuid[] := ARRAY[]::uuid[];
  v_skipped_ids     uuid[] := ARRAY[]::uuid[];
  v_status          text := 'ok';
  v_reason          text := NULL;
  v_expires_at      timestamptz;
  v_search_deadline timestamptz;
  v_find_minutes    integer;
  v_new_trip_distance_m numeric;
  v_new_bearing     double precision;
  v_base_pct        numeric;
  v_reduction_pct   numeric;
  v_effective_pct   numeric;
  v_commissionable  integer;
  v_offered_net     integer;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', NULL,
      'round', NULL, 'wave', NULL, 'status', 'trip_not_found',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'trip_not_found'
    );
  END IF;

  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RETURN jsonb_build_object(
        'trip_id', p_trip_id,
        'trip_code', v_trip.trip_code,
        'round', COALESCE(v_trip.current_broadcast_round, 0),
        'status', 'payment_gate_failed',
        'offers_created', 0,
        'offer_ids', '[]'::jsonb,
        'selected_driver_ids', '[]'::jsonb,
        'skipped_driver_ids', '[]'::jsonb,
        'candidate_count', 0,
        'eligible_count', 0,
        'wave_cap', NULL,
        'search_radius_meters', NULL,
        'reason', SQLERRM,
        'code', CASE
          WHEN SQLERRM ILIKE '%PAYMENT_AUTHORISATION_INSUFFICIENT%'
            THEN 'PAYMENT_AUTHORISATION_INSUFFICIENT'
          ELSE 'PAYMENT_GATE_NOT_SATISFIED'
        END
      );
  END;

  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'global_dispatch_settings singleton missing';
  END IF;

  -- Max absolute sequences (cycles × 3), prefer trip stamp.
  v_max_rounds       := public.dispatch_max_broadcast_rounds(
    to_jsonb(v_g),
    v_trip.max_broadcast_rounds
  );
  v_presence_max_age := COALESCE(v_g.presence_max_age_seconds, 60);
  v_prev_seq         := COALESCE(v_trip.current_broadcast_round, 0);

  BEGIN
    INSERT INTO public.dispatch_round_advance_log(trip_id, previous_round, trigger_reason)
    VALUES (p_trip_id, v_prev_seq, COALESCE(p_trigger_reason, 'auto'));
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', v_prev_seq, 'status', 'duplicate_trigger',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'round already advanced for previous_round=' || v_prev_seq
    );
  END;

  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN jsonb_build_object(
      'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
      'round', v_prev_seq, 'status', 'skipped',
      'offers_created', 0, 'offer_ids', '[]'::jsonb,
      'selected_driver_ids', '[]'::jsonb, 'skipped_driver_ids', '[]'::jsonb,
      'candidate_count', 0, 'eligible_count', 0,
      'wave_cap', NULL, 'search_radius_meters', NULL,
      'reason', 'broadcast_disabled'
    );
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL OR v_trip.status = 'negotiating' THEN
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_prev_seq,
      'status','skipped','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',NULL,'search_radius_meters',NULL,
      'reason','trip_in_negotiation');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id AND ro.status = 'pending'
      AND (ro.negotiation_status IN ('waiting_customer','waiting_driver','waiting_driver_final')
           OR ro.expires_at > v_now)
  ) THEN
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_prev_seq,
      'status','skipped','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',NULL,'search_radius_meters',NULL,
      'reason','active_offers_outstanding');
  END IF;

  -- Wave / round derivation: 3 waves per round, rounds repeat.
  v_seq   := v_prev_seq + 1;
  v_wave  := ((v_seq - 1) % 3) + 1;
  v_round := ((v_seq - 1) / 3) + 1;
  v_max_radius := v_g.max_radius_meters;

  CASE v_wave
    WHEN 1 THEN
      v_wave_cap := v_g.wave1_size; v_radius := v_g.start_radius_meters;  v_expiry_secs := v_g.wave1_offer_expiry_seconds;
    WHEN 2 THEN
      v_wave_cap := v_g.wave2_size; v_radius := v_g.expand_radius_meters; v_expiry_secs := v_g.wave2_offer_expiry_seconds;
    ELSE
      v_wave_cap := v_g.wave3_size; v_radius := v_g.max_radius_meters;    v_expiry_secs := v_g.wave3_offer_expiry_seconds;
  END CASE;

  IF v_radius IS NULL OR v_wave_cap IS NULL OR v_expiry_secs IS NULL THEN
    RAISE EXCEPTION 'global_dispatch_settings missing wave configuration for wave %', v_wave;
  END IF;

  v_radius := LEAST(v_radius, COALESCE(v_max_radius, v_radius));

  -- Overall trip TTL controls the maximum search duration.
  v_find_minutes := GREATEST(1, COALESCE(v_g.max_driver_find_time_minutes, 3));
  v_search_deadline := COALESCE(
    v_trip.searching_expires_at,
    v_trip.created_at + make_interval(mins => v_find_minutes),
    v_now + make_interval(mins => v_find_minutes)
  );

  IF v_search_deadline <= v_now THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_round,'wave',v_wave,
      'status','exhausted','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',v_wave_cap,'search_radius_meters',v_radius,
      'reason','trip_search_window_elapsed');
  END IF;

  IF v_seq > v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN jsonb_build_object('trip_id',p_trip_id,'trip_code',v_trip.trip_code,'round',v_round,'wave',v_wave,
      'status','exhausted','offers_created',0,
      'offer_ids','[]'::jsonb,'selected_driver_ids','[]'::jsonb,'skipped_driver_ids','[]'::jsonb,
      'candidate_count',0,'eligible_count',0,'wave_cap',v_wave_cap,'search_radius_meters',v_radius,
      'reason','max_rounds_reached');
  END IF;

  -- Offer window never outlives the overall trip TTL.
  v_expires_at := LEAST(v_now + make_interval(secs => v_expiry_secs), v_search_deadline);

  -- Per-wave commission incentive (monotonic across waves/rounds).
  SELECT base_percent, reduction_percent, effective_percent
    INTO v_base_pct, v_reduction_pct, v_effective_pct
  FROM public.resolve_wave_commission_percent(
    v_wave, COALESCE(v_trip.max_wave_commission_reduction_percent, 0));

  v_commissionable := GREATEST(0,
    COALESCE(
      NULLIF(v_trip.final_customer_fare_pence, 0),
      NULLIF(v_trip.final_fare_pence, 0),
      NULLIF(v_trip.estimated_total_pence, 0),
      NULLIF(v_trip.gross_fare_pence, 0),
      NULLIF(v_trip.base_fare_pence, 0),
      0
    ) - COALESCE(v_trip.airport_charge_pence, 0));
  v_offered_net := GREATEST(0, v_commissionable - ROUND(v_commissionable * v_effective_pct / 100.0)::int);

  v_new_trip_distance_m := COALESCE(v_trip.estimated_distance_km, 0)::numeric * 1000.0;
  IF v_new_trip_distance_m <= 0 THEN
    v_new_trip_distance_m := public.haversine_meters(
      v_trip.pickup_latitude, v_trip.pickup_longitude,
      v_trip.dropoff_latitude, v_trip.dropoff_longitude);
  END IF;
  v_new_bearing := public.bearing_deg(
    v_trip.pickup_latitude, v_trip.pickup_longitude,
    v_trip.dropoff_latitude, v_trip.dropoff_longitude);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ride_offer_id', id, 'driver_id', driver_id, 'status', status,
           'broadcast_round', broadcast_round
         )), '[]'::jsonb)
    INTO v_previous_json
    FROM public.ride_offers WHERE trip_id = p_trip_id;

  DROP TABLE IF EXISTS _disp_candidates;
  CREATE TEMP TABLE _disp_candidates ON COMMIT DROP AS
  WITH base AS (
    SELECT d.id AS driver_id, d.driver_code, d.service_area_id, d.region_id, d.category_id,
           d.current_trip_id, d.last_offer_at, d.last_trip_end_at,
           dp.status AS presence_status, dp.presence_health, dp.push_token,
           dp.socket_connected, dp.last_heartbeat_at, dp.offline_reason,
           dp.last_gps_sample_at, dp.speed AS presence_speed,
           COALESCE(dp.lat, d.current_lat) AS lat,
           COALESCE(dp.lng, d.current_lng) AS lng,
           at.dropoff_latitude  AS active_drop_lat,
           at.dropoff_longitude AS active_drop_lng,
           at.pickup_latitude   AS active_pick_lat,
           at.pickup_longitude  AS active_pick_lng,
           at.estimated_distance_km AS active_est_km,
           at.estimated_duration_minutes AS active_est_min,
           at.started_at AS active_started_at
    FROM public.drivers d
    LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
    LEFT JOIN public.trips at ON at.id = d.current_trip_id
    WHERE d.approval_status = 'approved' AND d.documents_approved = true
      AND public.driver_passes_commission_wallet_dispatch_gate(d.id, p_trip_id)
      AND d.is_online = true AND COALESCE(d.driver_online_intent, false) = true
      AND NOT public.is_explicit_offline_reason(dp.offline_reason)
      AND COALESCE(dp.lat, d.current_lat) IS NOT NULL
      AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
      AND NOT (COALESCE(dp.lat, d.current_lat) = 0 AND COALESCE(dp.lng, d.current_lng) = 0)
      AND NOT (d.id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[])))
      AND NOT (d.id = ANY (COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[])))
      -- Hard exclusions: live / accepted / countered offers are never re-offered.
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
          AND ro.status IN ('pending','accepted','countered')
      )
      -- Soft declines: cooldown only (parity with Edge auto-dispatch).
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
          AND ro.status = 'declined'
          AND COALESCE(ro.responded_at, ro.updated_at, ro.offered_at) >
              (v_now - make_interval(secs => GREATEST(
                0,
                COALESCE(
                  (public.get_dispatch_settings(v_trip.service_area_id)).cooldown_after_reject_seconds,
                  180
                )
              )))
      )
      -- Lapsed offers may be re-offered, but only in a LATER round.
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = p_trip_id AND ro.driver_id = d.id
          AND ro.status IN ('expired','revoked')
          AND COALESCE(ro.dispatch_round, 1) >= v_round
      )
  ),
  active_counts AS (
    SELECT t.driver_id, count(*)::int AS active_count
      FROM public.trips t
     WHERE t.driver_id IS NOT NULL
       AND t.status IN ('driver_assigned','accepted','en_route_pickup','arrived','in_progress','pickup_in_progress','en_route_to_pickup','arrived_at_pickup','at_pickup','pickup_waiting','waiting','en_route_to_dropoff','en_route_to_stop','arrived_at_stop','at_stop','waiting_at_stop')
     GROUP BY t.driver_id
  ),
  queued_counts AS (
    SELECT t.driver_id, count(*)::int AS queued_count
      FROM public.trips t
     WHERE t.driver_id IS NOT NULL
       AND t.status = 'queued'
     GROUP BY t.driver_id
  )
  SELECT b.*,
    public.haversine_meters(v_trip.pickup_latitude, v_trip.pickup_longitude, b.lat, b.lng) AS distance_m,
    COALESCE(ac.active_count, 0) AS active_count,
    COALESCE(qc.queued_count, 0) AS queued_count,
    (b.push_token IS NOT NULL AND b.push_token <> '') AS has_push,
    (COALESCE(b.socket_connected, false) = true) AS has_realtime,
    (b.last_heartbeat_at IS NOT NULL
      AND b.last_heartbeat_at > v_now - make_interval(secs => v_presence_max_age)) AS healthy_heartbeat,
    (COALESCE(b.presence_health, 'healthy') = 'degraded') AS is_degraded,
    public.driver_location_state(true, b.last_heartbeat_at, b.last_gps_sample_at, b.presence_speed) = 'location_frozen' AS is_frozen,
    (v_trip.service_area_id IS NULL OR b.service_area_id = v_trip.service_area_id) AS sa_match,
    (v_trip.region_id IS NULL OR b.region_id = v_trip.region_id) AS region_match,
    (b.current_trip_id IS NULL) AS is_idle
  FROM base b
  LEFT JOIN active_counts ac ON ac.driver_id = b.driver_id
  LEFT JOIN queued_counts qc ON qc.driver_id = b.driver_id;

  DROP TABLE IF EXISTS _disp_eval;
  CREATE TEMP TABLE _disp_eval ON COMMIT DROP AS
  WITH stack_calc AS (
    SELECT c.*,
      CASE WHEN c.active_drop_lat IS NOT NULL AND c.active_drop_lng IS NOT NULL
        THEN public.haversine_meters(c.active_drop_lat, c.active_drop_lng,
                                     v_trip.pickup_latitude, v_trip.pickup_longitude)
        ELSE NULL END AS detour_extra_m,
      CASE WHEN c.active_est_km IS NOT NULL AND c.active_est_min IS NOT NULL AND c.active_est_min > 0
        THEN (c.active_est_km / c.active_est_min) * 60.0
        ELSE 30.0 END AS active_speed_kmh,
      CASE WHEN c.active_pick_lat IS NOT NULL AND c.active_drop_lat IS NOT NULL
        THEN public.bearing_deg(c.active_pick_lat, c.active_pick_lng,
                                c.active_drop_lat, c.active_drop_lng)
        ELSE NULL END AS active_bearing,
      CASE WHEN c.active_started_at IS NOT NULL AND c.active_est_min IS NOT NULL
        THEN GREATEST(0,
          c.active_est_min - EXTRACT(EPOCH FROM (v_now - c.active_started_at))/60.0)
        WHEN c.active_est_min IS NOT NULL
        THEN c.active_est_min::numeric
        ELSE NULL END AS active_remaining_min
    FROM _disp_candidates c
  ),
  with_quality AS (
    SELECT s.*,
      CASE WHEN s.active_bearing IS NULL THEN NULL
        ELSE abs(mod(((v_new_bearing - s.active_bearing + 540.0))::numeric, 360.0) - 180.0)
      END AS bearing_diff_deg,
      CASE WHEN s.detour_extra_m IS NULL THEN NULL
        ELSE (s.detour_extra_m / 1000.0) / NULLIF(s.active_speed_kmh,0) * 60.0
      END AS detour_min
    FROM stack_calc s
  ),
  final_eval AS (
    SELECT q.*,
      (NOT q.is_idle
        AND COALESCE(v_g.stacked_rides_enabled, false) = true
        AND v_g.max_stacked_rides IS NOT NULL
        AND v_g.max_stacked_rides >= 1
        AND q.active_count = 1
        AND q.queued_count < v_g.max_stacked_rides
      ) AS stack_pre_ok,
      CASE
        WHEN q.is_idle THEN NULL
        WHEN COALESCE(v_g.stacked_rides_enabled, false) = false THEN 'stacked_disabled'
        WHEN v_g.max_stacked_rides IS NULL OR v_g.max_stacked_rides < 1 THEN 'stacked_config_invalid'
        WHEN q.active_count <> 1 THEN 'stacked_active_count_invalid'
        WHEN q.queued_count >= v_g.max_stacked_rides THEN 'stacked_cap_reached'
        WHEN q.distance_m > COALESCE(v_g.stacked_search_radius_meters, q.distance_m) THEN 'stacked_radius_exceeded'
        WHEN v_new_trip_distance_m < COALESCE(v_g.stacked_min_trip_distance_meters, 0) THEN 'stacked_min_distance'
        WHEN q.detour_min IS NOT NULL AND q.detour_min > COALESCE(v_g.stacked_max_detour_minutes, 9999) THEN 'stacked_detour_exceeded'
        WHEN COALESCE(v_g.stacked_same_direction_only, true) = true
             AND q.bearing_diff_deg IS NOT NULL AND q.bearing_diff_deg > 90.0 THEN 'stacked_wrong_direction'
        WHEN q.active_remaining_min IS NOT NULL
             AND q.active_remaining_min > COALESCE(v_g.stacked_offer_window_minutes, 9999) THEN 'stacked_window_too_far'
        ELSE NULL
      END AS stacked_reject_reason
    FROM with_quality q
  )
  SELECT f.*,
    (f.stack_pre_ok
      AND f.distance_m <= COALESCE(v_g.stacked_search_radius_meters, f.distance_m)
      AND v_new_trip_distance_m >= COALESCE(v_g.stacked_min_trip_distance_meters, 0)
      AND (f.detour_min IS NULL OR f.detour_min <= COALESCE(v_g.stacked_max_detour_minutes, 9999))
      AND (COALESCE(v_g.stacked_same_direction_only, true) = false
           OR f.bearing_diff_deg IS NULL
           OR f.bearing_diff_deg <= 90.0)
      AND (f.active_remaining_min IS NULL
           OR f.active_remaining_min <= COALESCE(v_g.stacked_offer_window_minutes, 9999))
    ) AS stack_ok,
    CASE
      WHEN f.distance_m > v_radius THEN 'out_of_radius'
      WHEN NOT f.sa_match THEN 'service_area_mismatch'
      WHEN NOT f.region_match THEN 'region_mismatch'
      WHEN NOT f.healthy_heartbeat THEN 'stale_heartbeat'
      WHEN f.is_frozen THEN 'location_frozen'
      WHEN NOT (f.has_push OR f.has_realtime) THEN 'no_delivery_channel'
      WHEN f.presence_health = 'offline' THEN 'presence_offline'
      ELSE NULL
    END AS reject_reason
  FROM final_eval f;

  UPDATE _disp_eval
     SET reject_reason = COALESCE(reject_reason,
       CASE WHEN NOT is_idle AND NOT stack_ok
            THEN COALESCE(stacked_reject_reason, 'busy_no_stack')
            ELSE NULL END)
   WHERE true;

  DROP TABLE IF EXISTS _disp_scored;
  CREATE TEMP TABLE _disp_scored ON COMMIT DROP AS
  SELECT e.*,
    (e.distance_m * COALESCE(v_g.distance_penalty_per_meter, 0)::numeric
      + CASE WHEN e.is_degraded THEN COALESCE(v_g.degraded_driver_penalty, 100) ELSE 0 END
      - LEAST(GREATEST(EXTRACT(EPOCH FROM (v_now - COALESCE(e.last_offer_at, e.last_trip_end_at, v_now)))/60.0, 0),
              COALESCE(v_g.max_waiting_bonus_minutes, 0)) * COALESCE(v_g.waiting_bonus_per_minute, 0)::numeric
      - CASE
          WHEN COALESCE(v_g.fairness_idle_minutes, 0) > 0
           AND EXTRACT(EPOCH FROM (v_now - COALESCE(e.last_offer_at, e.last_trip_end_at, v_now)))/60.0
               >= v_g.fairness_idle_minutes
          THEN COALESCE(v_g.fairness_boost_score, 0)
          ELSE 0
        END)::numeric AS score
  FROM _disp_eval e;

  PERFORM public.log_dispatch_eligibility(
    p_trip_id, s.driver_id, (s.reject_reason IS NULL), s.reject_reason,
    jsonb_build_object('wave',v_wave,'round',v_round,'wave_sequence',v_seq,
      'trigger_reason',p_trigger_reason,
      'driver_code',s.driver_code,'distance_m',s.distance_m,'score',s.score,
      'is_degraded',s.is_degraded,'sa_match',s.sa_match,'region_match',s.region_match,
      'has_push',s.has_push,'has_realtime',s.has_realtime,
      'healthy_heartbeat',s.healthy_heartbeat,'is_idle',s.is_idle,
      'stack_ok',s.stack_ok,'active_count',s.active_count,
      'stacked_reject_reason', s.stacked_reject_reason,
      'detour_min', s.detour_min,
      'bearing_diff_deg', s.bearing_diff_deg,
      'active_remaining_min', s.active_remaining_min,
      'new_trip_distance_m', v_new_trip_distance_m,
      'hard_excluded',(s.reject_reason IS NOT NULL)))
  FROM _disp_scored s;

  SELECT count(*), count(*) FILTER (WHERE reject_reason IS NULL),
         count(*) FILTER (WHERE is_degraded), count(*) FILTER (WHERE reject_reason IS NOT NULL)
    INTO v_candidate_count, v_eligible_count, v_degraded_count, v_hard_excl_count
    FROM _disp_scored;

  SELECT COALESCE(array_agg(driver_id), ARRAY[]::uuid[]) INTO v_skipped_ids
    FROM _disp_scored WHERE reject_reason IS NOT NULL;

  WITH picks AS (
    SELECT driver_id, distance_m, score, stack_ok, is_degraded
      FROM _disp_scored WHERE reject_reason IS NULL
      ORDER BY score ASC, distance_m ASC LIMIT v_wave_cap
  ),
  ins AS (
    INSERT INTO public.ride_offers (
      trip_id, driver_id, status, expires_at, distance_meters,
      broadcast_round, dispatch_wave, dispatch_round, offered_at, is_stacked,
      base_commission_percent, wave_commission_reduction_percent,
      effective_commission_percent, offered_driver_net_pence, offer_snapshot
    )
    SELECT p_trip_id, p.driver_id, 'pending', v_expires_at, round(p.distance_m)::int,
      v_seq, v_wave, v_round, v_now, p.stack_ok,
      v_base_pct, v_reduction_pct, v_effective_pct, v_offered_net,
      jsonb_build_object('wave',v_wave,'round',v_round,'wave_sequence',v_seq,
                         'score',p.score,'trigger_reason',p_trigger_reason,
                         'degraded',p.is_degraded,'stacked',p.stack_ok,
                         'base_commission_percent',v_base_pct,
                         'wave_commission_reduction_percent',v_reduction_pct,
                         'effective_commission_percent',v_effective_pct,
                         'offered_driver_net_pence',v_offered_net)
    FROM picks p
    RETURNING id, driver_id
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]),
         COALESCE(array_agg(driver_id), ARRAY[]::uuid[]),
         count(*)::int
    INTO v_offer_ids, v_selected_ids, v_inserted
    FROM ins;

  v_selected_count := v_inserted;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'driver_id', ro.driver_id, 'ride_offer_id', ro.id,
           'distance_m', ro.distance_meters, 'is_stacked', ro.is_stacked,
           'offered_driver_net_pence', ro.offered_driver_net_pence,
           'effective_commission_percent', ro.effective_commission_percent)), '[]'::jsonb)
    INTO v_selected_json
   FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id AND ro.broadcast_round = v_seq;

  IF v_inserted = 0 THEN
    UPDATE public.trips
      SET current_broadcast_round=v_seq, last_broadcast_at=v_now,
          searching_expires_at=COALESCE(searching_expires_at, v_search_deadline),
          max_wave_commission_reduction_percent=GREATEST(
            COALESCE(max_wave_commission_reduction_percent,0), v_reduction_pct),
          updated_at=v_now
      WHERE id=p_trip_id;
    v_status := 'no_drivers';
    v_reason := 'no_eligible_drivers';
  ELSE
    UPDATE public.trips
      SET status='offered', dispatch_status='broadcasting',
          current_broadcast_round=v_seq,
          broadcast_started_at=COALESCE(v_trip.broadcast_started_at, v_now),
          last_broadcast_at=v_now,
          searching_expires_at=COALESCE(searching_expires_at, v_search_deadline),
          max_wave_commission_reduction_percent=GREATEST(
            COALESCE(max_wave_commission_reduction_percent,0), v_reduction_pct),
          updated_at=v_now
      WHERE id=p_trip_id;
    v_status := 'dispatched';
  END IF;

  INSERT INTO public.dispatch_wave_snapshots(
    trip_id, dispatch_round, trigger_reason, wave_cap, search_radius_meters,
    candidate_count, eligible_count, degraded_count, hard_excluded_count,
    selected_count, offer_created_count, selected_drivers, previous_round_drivers,
    reason_for_next_wave
  ) VALUES (
    p_trip_id, v_seq, p_trigger_reason, v_wave_cap, v_radius,
    v_candidate_count, v_eligible_count, v_degraded_count, v_hard_excl_count,
    v_selected_count, v_inserted, v_selected_json, v_previous_json,
    CASE WHEN v_inserted = 0 THEN 'no_eligible_drivers' ELSE NULL END
  );

  IF v_inserted = 0 THEN
    PERFORM public.maybe_advance_dispatch_after_offer_resolution(p_trip_id, NULL);
  END IF;

  RETURN jsonb_build_object(
    'trip_id', p_trip_id, 'trip_code', v_trip.trip_code,
    'round', v_round, 'wave', v_wave, 'wave_sequence', v_seq,
    'status', v_status,
    'offers_created', v_inserted,
    'offer_ids', to_jsonb(v_offer_ids),
    'selected_driver_ids', to_jsonb(v_selected_ids),
    'skipped_driver_ids', to_jsonb(v_skipped_ids),
    'candidate_count', v_candidate_count,
    'eligible_count', v_eligible_count,
    'wave_cap', v_wave_cap,
    'search_radius_meters', v_radius,
    'base_commission_percent', v_base_pct,
    'wave_commission_reduction_percent', v_reduction_pct,
    'effective_commission_percent', v_effective_pct,
    'offered_driver_net_pence', v_offered_net,
    'reason', v_reason
  );
END;
$function$

