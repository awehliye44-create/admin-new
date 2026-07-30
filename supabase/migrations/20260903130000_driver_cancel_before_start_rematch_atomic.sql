-- Phase 2C/2D: atomic driver_cancel_before_start_rematch + hard guards + exclusion hardening.
-- Do not invoke HTTP from this transaction; durable dispatch intent outbox only.

-- ---------------------------------------------------------------------------
-- 1) Schema: exclusion source + idempotency + dispatch outbox + audit
-- ---------------------------------------------------------------------------

ALTER TABLE public.trip_driver_exclusions
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS audit_event_id uuid,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.trip_driver_exclusions.source IS
  'Durable exclusion origin SSOT, e.g. driver_cancel_before_start';

CREATE TABLE IF NOT EXISTS public.driver_cancel_rematch_idempotency (
  idempotency_key text PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_cancel_rematch_idempotency_trip
  ON public.driver_cancel_rematch_idempotency (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.dispatch_intent_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  intent text NOT NULL DEFAULT 'auto_dispatch_rebroadcast',
  trigger_reason text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'done'::text, 'failed'::text])),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT dispatch_intent_outbox_idempotency_key_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_intent_outbox_pending
  ON public.dispatch_intent_outbox (status, created_at)
  WHERE status = ANY (ARRAY['pending'::text, 'failed'::text]);

CREATE TABLE IF NOT EXISTS public.driver_cancel_rematch_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL,
  previous_status text,
  resulting_status text NOT NULL,
  reason text,
  actor text NOT NULL,
  actor_mode text NOT NULL,
  idempotency_key text,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  broadcast_round_before integer,
  broadcast_round_after integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_cancel_rematch_audit_trip
  ON public.driver_cancel_rematch_audit (trip_id, created_at DESC);

-- One active accepted assignment per trip (pre-clean duplicates so index apply is safe).
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY trip_id
      ORDER BY COALESCE(responded_at, updated_at, offered_at, created_at) DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.ride_offers
  WHERE status = 'accepted'
)
UPDATE public.ride_offers ro
SET
  status = 'revoked',
  revoked_reason = COALESCE(ro.revoked_reason, 'duplicate_accepted_pre_unique_index'),
  updated_at = now()
FROM ranked
WHERE ro.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS ride_offers_one_accepted_per_trip
  ON public.ride_offers (trip_id)
  WHERE status = 'accepted';

GRANT SELECT, INSERT, UPDATE ON public.driver_cancel_rematch_idempotency TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.dispatch_intent_outbox TO service_role;
GRANT SELECT, INSERT ON public.driver_cancel_rematch_audit TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.trip_driver_exclusions TO service_role;

-- ---------------------------------------------------------------------------
-- 2) Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.driver_is_excluded_from_trip(
  p_trip_id uuid,
  p_driver_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.trip_driver_exclusions tde
      WHERE tde.trip_id = p_trip_id
        AND tde.driver_id = p_driver_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.trips t
      WHERE t.id = p_trip_id
        AND (
          p_driver_id = ANY (COALESCE(t.cancelled_driver_ids, '{}'::uuid[]))
          OR p_driver_id = ANY (COALESCE(t.excluded_driver_ids, '{}'::uuid[]))
        )
    );
$fn$;

CREATE OR REPLACE FUNCTION public.is_driver_cancel_rematch_eligible_status(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT lower(COALESCE(p_status, '')) = ANY (ARRAY[
    'confirmed',
    'accepted',
    'driver_assigned',
    'en_route',
    'en_route_to_pickup',
    'driver_en_route',
    'enroute_to_pickup',
    'driver_arriving',
    'queued',
    'arrived',
    'arrived_pickup',
    'arrived_at_pickup',
    'at_pickup',
    'pickup_waiting',
    'waiting',
    'driver_arrived',
    'waiting_at_pickup'
  ]::text[]);
$fn$;

CREATE OR REPLACE FUNCTION public.is_driver_cancel_rematch_rejected_status(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT lower(COALESCE(p_status, '')) = ANY (ARRAY[
    'no_show',
    'no-show',
    'in_progress',
    'on_trip',
    'started',
    'ongoing',
    'completing',
    'passenger_onboard',
    'completed',
    'cancelled',
    'canceled',
    'customer_cancelled',
    'customer_canceled',
    'expired',
    'expired_no_driver',
    'declined',
    'failed',
    'searching_new_driver'
  ]::text[]);
$fn$;

-- Recognize rematch rows for cancel-assignment invariant (status + dispatch).
CREATE OR REPLACE FUNCTION public.is_active_driver_cancel_rematch_row(p_trip trips)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT
    lower(COALESCE(p_trip.cancelled_by, '')) = 'driver'
    AND lower(COALESCE(p_trip.cancel_reason, '')) = 'driver_cancelled'
    AND p_trip.confirmed_driver_id IS NULL
    AND p_trip.driver_id IS NULL
    AND (
      lower(COALESCE(p_trip.status, '')) = 'searching_new_driver'
      OR lower(COALESCE(p_trip.dispatch_status, '')) IN (
        'broadcasting', 'searching', 'offering', 'offered', 'searching_new_driver'
      )
    )
    AND (
      p_trip.searching_expires_at IS NULL
      OR p_trip.searching_expires_at > now()
    );
$fn$;

-- ---------------------------------------------------------------------------
-- 3) Atomic rematch RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.driver_cancel_before_start_rematch(
  p_trip_id uuid,
  p_driver_id uuid,
  p_reason text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_request_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
    'stripe_payment_intent_id', v_trip.stripe_payment_intent_id,
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
  -- auto-dispatch owns the next-wave increment (storedRound+1). Rematch records
  -- the intended next round for audit/outbox only and does not advance the trip
  -- column here (avoids double-burn against max_broadcast_rounds).
  v_round_after := GREATEST(v_round_before, v_max_offer_round);

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
    -- Leave current_broadcast_round unchanged; deployed auto-dispatch advances it.
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
    'stripe_payment_intent_id', t.stripe_payment_intent_id,
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
$fn$;

REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Phase 2D hard guards
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_driver_cancel_rematch_invariants()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $guard$
DECLARE
  v_old text := lower(COALESCE(OLD.status, ''));
  v_new text := lower(COALESCE(NEW.status, ''));
BEGIN
  -- searching_new_driver cannot retain an active assignment
  IF v_new = 'searching_new_driver' AND NEW.confirmed_driver_id IS NOT NULL THEN
    RAISE EXCEPTION 'REMATCH_INVARIANT: searching_new_driver cannot have confirmed_driver_id'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Explicit denials for terminal / no-show / started → searching_new_driver
  IF TG_OP = 'UPDATE'
     AND v_old IS DISTINCT FROM v_new
     AND v_new = 'searching_new_driver'
     AND public.is_driver_cancel_rematch_rejected_status(v_old)
  THEN
    RAISE EXCEPTION 'REMATCH_INVARIANT: cannot transition % to searching_new_driver', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rematch entry also requires a rematch-eligible pre-start source status
  -- (blocks pending/searching/offered → searching_new_driver from non-RPC writers).
  IF TG_OP = 'UPDATE'
     AND v_old IS DISTINCT FROM v_new
     AND v_new = 'searching_new_driver'
     AND NOT public.is_driver_cancel_rematch_eligible_status(v_old)
  THEN
    RAISE EXCEPTION 'REMATCH_INVARIANT: cannot transition % to searching_new_driver', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Physical progression / waiting / complete requires an active assignment.
  -- Blocks stale old-driver Arrive / Start / waiting / complete after rematch clear.
  IF v_new IN (
    'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup', 'pickup_waiting',
    'waiting', 'driver_arrived', 'waiting_at_pickup',
    'en_route', 'en_route_to_pickup', 'driver_en_route', 'enroute_to_pickup', 'driver_arriving',
    'in_progress', 'on_trip', 'started', 'ongoing', 'passenger_onboard', 'completing'
  ) AND NEW.confirmed_driver_id IS NULL THEN
    RAISE EXCEPTION 'ASSIGNMENT_REQUIRED: status % requires confirmed_driver_id', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Stale complete from rematch/searching without assignment is forbidden
  -- (admin force-complete must set assignment or use a non-searching source status path).
  IF TG_OP = 'UPDATE'
     AND v_new = 'completed'
     AND NEW.confirmed_driver_id IS NULL
     AND v_old IN ('searching_new_driver', 'searching', 'broadcasting', 'offered', 'pending')
  THEN
    RAISE EXCEPTION 'ASSIGNMENT_REQUIRED: cannot complete from % without confirmed_driver_id', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS tr_enforce_driver_cancel_rematch_invariants ON public.trips;
CREATE TRIGGER tr_enforce_driver_cancel_rematch_invariants
  BEFORE INSERT OR UPDATE OF status, confirmed_driver_id ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_driver_cancel_rematch_invariants();


-- ---------------------------------------------------------------------------
-- 5) Hardening: accept_ride_offer + dispatch_trip_offers exclusion SSOT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.accept_ride_offer(p_offer_id uuid, p_driver_id uuid, p_allow_customer_counter boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_fare_pence integer;
  v_fare_source text;
  v_original_fare_pence integer;
  v_gross_pence integer;
  v_discount_pence integer;
  v_booking_net_pence integer;
  v_final_customer_pence integer;
  v_locked_base_pence integer;
  v_fare_finalize jsonb;
  v_preset_key text;
  v_preset_fare_pence integer;
  v_now timestamptz := now();
BEGIN
  PERFORM p_allow_customer_counter;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;

  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;

  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id OR v_trip.confirmed_driver_id = p_driver_id THEN
      PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);
      RETURN jsonb_build_object(
        'success', true,
        'trip_id', v_offer.trip_id,
        'status', v_trip.status,
        'driver_id', p_driver_id,
        'final_fare_pence', v_trip.final_fare_pence,
        'final_customer_fare_pence', v_trip.final_customer_fare_pence,
        'fare_source', COALESCE(v_trip.fare_snapshot_json->>'fare_source', 'original_fare'),
        'accepted_via', 'accept_ride_offer',
        'idempotent', true
      );
    END IF;
  END IF;

  IF v_offer.status NOT IN ('pending', 'countered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_PENDING', 'message', 'Offer already ' || COALESCE(v_offer.status, 'handled'));
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer'
     AND v_offer.negotiation_status IS DISTINCT FROM 'declined_customer_awaiting_driver'
     AND NOT (COALESCE(v_offer.driver_offer_fare, 0) > 0 AND v_offer.status IN ('pending', 'countered'))
     AND NOT (v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') AND COALESCE(v_offer.customer_counter_fare, 0) > 0)
     AND NOT (v_offer.negotiation_status IS NULL AND v_offer.status IN ('pending', 'countered')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_ACCEPTABLE', 'message', 'Offer is not awaiting acceptance');
  END IF;

  IF v_offer.customer_respond_by IS NOT NULL AND v_offer.customer_respond_by < v_now AND v_offer.negotiation_status = 'waiting_customer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;
  IF v_offer.driver_respond_by IS NOT NULL AND v_offer.driver_respond_by < v_now AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Counter-offer response window expired');
  END IF;
  IF v_offer.negotiation_expires_at IS NOT NULL AND v_offer.negotiation_expires_at < v_now AND v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Standard fare acceptance window expired');
  END IF;
  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;
  IF v_trip.driver_id IS NOT NULL AND v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.status NOT IN ('pending','searching','searching_new_driver','offered','broadcasting','offering','negotiating','accepted','confirmed','driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride not available for assignment');
  END IF;

  -- Phase 2D: exclusion table is durable SSOT; arrays remain compatibility checks.
  IF public.driver_is_excluded_from_trip(v_offer.trip_id, p_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_EXCLUDED',
      'message', 'Driver is excluded from this trip'
    );
  END IF;

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_offer.counter_fare, 0),
    0
  );

  IF COALESCE(v_offer.customer_counter_fare, 0) > 0
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') THEN
    v_fare_pence := v_offer.customer_counter_fare;
    v_fare_source := 'customer_counter_offer';
  ELSIF COALESCE(v_offer.driver_offer_fare, 0) > 0
     AND v_offer.negotiation_status = 'waiting_customer' THEN
    v_fare_pence := v_offer.driver_offer_fare;
    v_fare_source := 'negotiated_offer';
  ELSIF v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  ELSE
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  END IF;

  IF v_fare_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FARE', 'message', 'Invalid fare');
  END IF;

  v_gross_pence := COALESCE(NULLIF(v_trip.gross_fare_pence, 0), NULLIF(v_original_fare_pence, 0), v_fare_pence);
  v_discount_pence := COALESCE(NULLIF(v_trip.discount_pence, 0), NULLIF(v_trip.offer_discount_pence, 0), 0);
  v_booking_net_pence := COALESCE(NULLIF(v_trip.final_customer_fare_pence, 0), NULLIF(v_trip.final_fare_pence, 0));

  IF v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := v_fare_pence;
    IF v_gross_pence > v_fare_pence THEN
      v_discount_pence := GREATEST(v_discount_pence, v_gross_pence - v_fare_pence);
    END IF;
  ELSIF v_booking_net_pence IS NOT NULL AND v_booking_net_pence > 0 AND v_gross_pence > v_booking_net_pence THEN
    v_final_customer_pence := v_booking_net_pence;
    v_locked_base_pence := v_gross_pence;
  ELSIF v_discount_pence > 0 AND v_gross_pence > v_discount_pence THEN
    v_final_customer_pence := v_gross_pence - v_discount_pence;
    v_locked_base_pence := v_gross_pence;
  ELSE
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := COALESCE(NULLIF(v_gross_pence, 0), v_fare_pence);
  END IF;

  -- Preset selection tracking (SSOT completeness)
  v_preset_key := NULLIF(v_offer.offer_snapshot->>'selectedOfferKey', '');
  IF v_preset_key IS NOT NULL THEN
    v_preset_fare_pence := NULLIF((v_offer.offer_snapshot->'selectedOffer'->>'grossFarePence')::integer, 0);
  END IF;

  v_fare_finalize := public.finalize_negotiated_fare(v_offer.trip_id, p_offer_id, v_final_customer_pence, v_fare_source, p_driver_id);

  IF COALESCE(v_fare_finalize->>'success', 'false') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'error', 'FARE_FINALIZE_FAILED', 'message', COALESCE(v_fare_finalize->>'error', 'Could not finalize fare'));
  END IF;

  UPDATE public.ride_offers
  SET
    status = 'accepted',
    negotiation_status = 'confirmed',
    driver_offer_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE driver_offer_fare END,
    counter_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE counter_fare END,
    responded_at = v_now,
    customer_respond_by = NULL,
    driver_respond_by = NULL,
    grace_window_expires_at = NULL,
    negotiation_expires_at = NULL,
    expires_at = v_now + interval '7 days',
    updated_at = v_now
  WHERE id = p_offer_id;

  UPDATE public.ride_offers
  SET status = 'revoked', revoked_reason = 'another_offer_accepted', negotiation_status = NULL,
      customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
      negotiation_expires_at = NULL, updated_at = v_now
  WHERE trip_id = v_offer.trip_id AND id <> p_offer_id AND status IN ('pending', 'countered');

  UPDATE public.trips
  SET
    status = 'driver_assigned',
    driver_id = p_driver_id,
    confirmed_driver_id = p_driver_id,
    negotiation_owner_driver_id = NULL,
    negotiation_locked_until = NULL,
    negotiation_status = 'confirmed',
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    dispatch_status = 'assigned',
    searching_expires_at = NULL,
    assigned_at = COALESCE(assigned_at, v_now),
    accepted_ride_offer_id = p_offer_id,
    cancelled_at = NULL,
    cancelled_by = NULL,
    cancel_reason = NULL,
    cancellation_reason = NULL,
    cancellation_note = NULL,
    accepted_driver_offer_fare_pence = CASE
      WHEN v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_driver_offer_fare_pence
    END,
    accepted_preset_offer_fare_pence = CASE
      WHEN v_preset_key IS NOT NULL AND v_preset_fare_pence IS NOT NULL THEN v_preset_fare_pence
      WHEN v_preset_key IS NOT NULL AND v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_preset_offer_fare_pence
    END,
    locked_offer_type = CASE
      WHEN v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN v_fare_source
      ELSE locked_offer_type
    END,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'original_fare_pence', NULLIF(v_original_fare_pence, 0),
        'accepted_via', 'accept_ride_offer',
        'accepted_at', v_now,
        'accepted_preset_key', v_preset_key,
        'accepted_preset_fare_pence', v_preset_fare_pence
      )),
    updated_at = v_now
  WHERE id = v_offer.trip_id;

  UPDATE public.drivers SET current_trip_id = v_offer.trip_id, updated_at = v_now WHERE id = p_driver_id;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers SET active_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id;
  END IF;

  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  BEGIN
    PERFORM public.record_booking_delivery(v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_fare_source,
        'final_fare_pence', v_final_customer_pence,
        'final_customer_fare_pence', v_final_customer_pence,
        'accepted_preset_key', v_preset_key,
        'accepted_via', 'accept_ride_offer'
      )));
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[accept_ride_offer] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_offer.trip_id,
    'status', 'driver_assigned',
    'driver_id', p_driver_id,
    'final_fare_pence', v_final_customer_pence,
    'final_customer_fare_pence', v_final_customer_pence,
    'gross_fare_pence', (v_fare_finalize->>'gross_fare_pence')::integer,
    'discount_pence', v_discount_pence,
    'commission_pence', (v_fare_finalize->>'commission_pence')::integer,
    'driver_net_pence', (v_fare_finalize->>'driver_net_pence')::integer,
    'fare_source', v_fare_source,
    'accepted_preset_key', v_preset_key,
    'accepted_preset_fare_pence', v_preset_fare_pence,
    'original_fare_pence', v_original_fare_pence,
    'counter_offer_amount_pence', v_offer.customer_counter_fare,
    'accepted_via', 'accept_ride_offer'
  );
END;
$function$;

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
          -- Declined/expired remain blocked here; cooldown below still applies.
          AND ro.status IN ('pending', 'declined', 'accepted', 'countered')
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

$function$;
