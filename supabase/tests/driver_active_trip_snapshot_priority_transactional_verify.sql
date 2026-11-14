-- ARTIFACT: rolled-back linked verification for draft 20270222250000 (corrected eligibility).
-- MUST end in ROLLBACK. Never COMMIT. Never use as a production apply script.
BEGIN;

CREATE TEMP TABLE _verify_results (
  step text PRIMARY KEY,
  detail text
);
INSERT INTO _verify_results VALUES (
  'prod_before_md5',
  md5(pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure))
);
INSERT INTO _verify_results
SELECT 'prod_before_has_updated_at_order',
  CASE WHEN pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure)
    LIKE '%ORDER BY t.updated_at DESC NULLS LAST%' THEN 'yes' ELSE 'no' END;

-- === INSTALL PROPOSED DRAFT ===
-- REVIEW ONLY — DO NOT APPLY IN PRODUCTION WITHOUT EXPLICIT APPROVAL.
-- Final migration version: 20270222250000 (after remote head 20270222240000).
-- MK-261114-002: get_driver_active_trip_snapshot must never prefer a newer
-- future scheduled commitment over a genuine active trip, and must return
-- empty active_trip when the driver only has unactivated Scheduled Jobs
-- commitments — including legacy accept_scheduled_ride status='accepted'.
--
-- Rollback: supabase/migrations/rollback/rollback_20270222250000_driver_active_trip_snapshot_priority.sql
-- Isolated tests: supabase/tests/driver_active_trip_snapshot_priority_isolated.sql
-- Lock: supabase/tests/_shared/driverActiveTripSnapshotPriorityLock.test.ts
--
-- Changes ONLY active-trip selection eligibility + priority (+ anomaly LOG).
-- No trip/payment/dispatch/notification/waiting/financial mutations.
-- Preserves RPC signature, response shape keys, auth, grants, SECURITY DEFINER,
-- search_path=public, and assignment ownership (driver_id OR confirmed_driver_id).

-- ---------------------------------------------------------------------------
-- Status allowlist (necessary but not sufficient for scheduled-origin rows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_status(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $helper$
  SELECT lower(coalesce(p_status, '')) IN (
    'accepted', 'confirmed', 'driver_assigned', 'assigned',
    'en_route', 'en_route_to_pickup', 'en_route_pickup',
    'driver_en_route', 'enroute_to_pickup', 'driver_arriving',
    'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
    'pickup_waiting', 'waiting', 'waiting_at_pickup', 'driver_arrived',
    'at_stop', 'arrived_stop', 'arrived_at_stop', 'stop_waiting',
    'waiting_at_stop', 'intermediate_stop_waiting',
    'en_route_to_stop', 'en_route_stop',
    'in_progress', 'started', 'on_trip', 'ongoing', 'trip_started',
    'pickup_in_progress',
    'en_route_to_dropoff', 'en_route_destination', 'en_route_dropoff'
  );
$helper$;

CREATE OR REPLACE FUNCTION public.driver_active_trip_snapshot_lifecycle_rank(p_status text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $helper$
  SELECT CASE lower(coalesce(p_status, ''))
    WHEN 'in_progress' THEN 10
    WHEN 'started' THEN 10
    WHEN 'on_trip' THEN 10
    WHEN 'ongoing' THEN 10
    WHEN 'trip_started' THEN 10
    WHEN 'pickup_in_progress' THEN 10
    WHEN 'en_route_to_dropoff' THEN 10
    WHEN 'en_route_destination' THEN 10
    WHEN 'en_route_dropoff' THEN 10
    WHEN 'at_stop' THEN 20
    WHEN 'arrived_stop' THEN 20
    WHEN 'arrived_at_stop' THEN 20
    WHEN 'stop_waiting' THEN 20
    WHEN 'waiting_at_stop' THEN 20
    WHEN 'intermediate_stop_waiting' THEN 20
    WHEN 'en_route_to_stop' THEN 20
    WHEN 'en_route_stop' THEN 20
    WHEN 'arrived' THEN 30
    WHEN 'arrived_pickup' THEN 30
    WHEN 'arrived_at_pickup' THEN 30
    WHEN 'at_pickup' THEN 30
    WHEN 'pickup_waiting' THEN 30
    WHEN 'waiting' THEN 30
    WHEN 'waiting_at_pickup' THEN 30
    WHEN 'driver_arrived' THEN 30
    WHEN 'en_route' THEN 40
    WHEN 'en_route_to_pickup' THEN 40
    WHEN 'en_route_pickup' THEN 40
    WHEN 'driver_en_route' THEN 40
    WHEN 'enroute_to_pickup' THEN 40
    WHEN 'driver_arriving' THEN 40
    WHEN 'accepted' THEN 50
    WHEN 'confirmed' THEN 50
    WHEN 'driver_assigned' THEN 50
    WHEN 'assigned' THEN 50
    ELSE 90
  END;
$helper$;

-- ---------------------------------------------------------------------------
-- Authoritative scheduled activation (composite — mirrors
-- scheduledConfirmedActivationSSOT.isAlreadyConfirmedActivated + live workflow
-- progression + Phase 4/5 / legacy journey metadata). Never uses scheduled_at
-- future-ness alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_scheduled_activated(
  p_status text,
  p_scheduled_status text,
  p_scheduled_jit_activated_at timestamptz,
  p_driver_started_journey_to_pickup_at timestamptz,
  p_driver_checked_in_at timestamptz,
  p_pickup_arrived_at timestamptz,
  p_arrived_at timestamptz,
  p_started_at timestamptz,
  p_scheduled_ack_status text DEFAULT NULL,
  p_scheduled_ack_acknowledged_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $helper$
  SELECT
    -- Primary activation SSOT
    lower(trim(coalesce(p_scheduled_status, ''))) IN ('driver_en_route', 'en_route_to_pickup')
    -- Live workflow statuses (past mere assignment aliases)
    OR lower(trim(coalesce(p_status, ''))) IN (
      'en_route', 'en_route_to_pickup', 'en_route_pickup',
      'driver_en_route', 'enroute_to_pickup', 'driver_arriving',
      'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
      'pickup_waiting', 'waiting', 'waiting_at_pickup', 'driver_arrived',
      'at_stop', 'arrived_stop', 'arrived_at_stop', 'stop_waiting',
      'waiting_at_stop', 'intermediate_stop_waiting',
      'en_route_to_stop', 'en_route_stop',
      'in_progress', 'started', 'on_trip', 'ongoing', 'trip_started',
      'pickup_in_progress',
      'en_route_to_dropoff', 'en_route_destination', 'en_route_dropoff'
    )
    -- Activation / journey / arrival metadata
    OR p_scheduled_jit_activated_at IS NOT NULL
    OR p_driver_started_journey_to_pickup_at IS NOT NULL
    OR p_driver_checked_in_at IS NOT NULL
    OR p_pickup_arrived_at IS NOT NULL
    OR p_arrived_at IS NOT NULL
    OR p_started_at IS NOT NULL
    -- Phase 5 Heading acknowledgement (activation may stamp en_route next)
    OR lower(trim(coalesce(p_scheduled_ack_status, ''))) = 'acknowledged'
    OR p_scheduled_ack_acknowledged_at IS NOT NULL;
$helper$;

-- True ⇒ still a Scheduled Jobs reservation; must NOT appear in active snapshot.
CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_unactivated_scheduled(
  p_status text,
  p_scheduled_status text,
  p_is_scheduled boolean,
  p_dispatch_mode text,
  p_scheduled_at timestamptz,
  p_scheduled_jit_activated_at timestamptz,
  p_driver_started_journey_to_pickup_at timestamptz,
  p_driver_checked_in_at timestamptz,
  p_pickup_arrived_at timestamptz,
  p_arrived_at timestamptz,
  p_started_at timestamptz,
  p_scheduled_ack_status text DEFAULT NULL,
  p_scheduled_ack_acknowledged_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $helper$
  SELECT
    (
      coalesce(p_is_scheduled, false)
      OR lower(replace(trim(coalesce(p_dispatch_mode, '')), '-', '_')) = 'scheduled'
      OR p_scheduled_at IS NOT NULL
    )
    -- Converted / instant dispatch is live work, not a reservation
    AND lower(replace(trim(coalesce(p_scheduled_status, '')), '-', '_'))
          IS DISTINCT FROM 'converted_to_instant'
    AND lower(replace(trim(coalesce(p_dispatch_mode, '')), '-', '_'))
          IS DISTINCT FROM 'instant'
    AND NOT public.is_driver_active_trip_snapshot_scheduled_activated(
      p_status,
      p_scheduled_status,
      p_scheduled_jit_activated_at,
      p_driver_started_journey_to_pickup_at,
      p_driver_checked_in_at,
      p_pickup_arrived_at,
      p_arrived_at,
      p_started_at,
      p_scheduled_ack_status,
      p_scheduled_ack_acknowledged_at
    );
$helper$;

-- Row eligibility used by the RPC (status allowlist ∧ ¬unactivated scheduled).
CREATE OR REPLACE FUNCTION public.is_driver_active_trip_snapshot_row_eligible(p_trip public.trips)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $helper$
  SELECT
    public.is_driver_active_trip_snapshot_status(p_trip.status)
    AND NOT public.is_driver_active_trip_snapshot_unactivated_scheduled(
      p_trip.status,
      p_trip.scheduled_status,
      p_trip.is_scheduled,
      p_trip.dispatch_mode,
      p_trip.scheduled_at,
      p_trip.scheduled_jit_activated_at,
      p_trip.driver_started_journey_to_pickup_at,
      p_trip.driver_checked_in_at,
      p_trip.pickup_arrived_at,
      p_trip.arrived_at,
      p_trip.started_at,
      p_trip.scheduled_ack_status,
      p_trip.scheduled_ack_acknowledged_at
    );
$helper$;

REVOKE EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_status(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_status(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.driver_active_trip_snapshot_lifecycle_rank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.driver_active_trip_snapshot_lifecycle_rank(text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_scheduled_activated(text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_scheduled_activated(text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_unactivated_scheduled(text, text, boolean, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_unactivated_scheduled(text, text, boolean, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_row_eligible(public.trips) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_driver_active_trip_snapshot_row_eligible(public.trips) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_trip record;
  v_queued jsonb;
  v_server_now timestamptz := now();
  v_no_show_wait_min numeric := 4;
  v_no_show_apply_after_arrival boolean := true;
  v_arrived_at timestamptz;
  v_status text;
  v_eligible_at timestamptz;
  v_remaining_seconds integer := 0;
  v_can_mark boolean := false;
  v_actions jsonb := '[]'::jsonb;
  v_active jsonb;
  v_passenger_id uuid;
  v_passenger_first_name text;
  v_passenger_last_name text;
  v_passenger_rating numeric;
  v_passenger_trip_count integer;
  v_stops jsonb := '[]'::jsonb;
  v_active_count integer := 0;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Anomaly report only (no trip mutation): multiple genuine active rows.
  SELECT count(*)::int INTO v_active_count
  FROM public.trips t
  WHERE (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
    AND public.is_driver_active_trip_snapshot_row_eligible(t);
  IF coalesce(v_active_count, 0) > 1 THEN
    RAISE LOG 'driver_active_trip_snapshot_anomaly driver_id=% active_count=%',
      v_driver_id, v_active_count;
  END IF;

  -- MK-261114-002: exclude unactivated scheduled commitments regardless of
  -- status aliases (scheduled/accepted/assigned/confirmed/driver_assigned).
  -- Prefer genuine live workflow by lifecycle rank — never updated_at alone.
  SELECT t.*
  INTO v_trip
  FROM public.trips t
  WHERE (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
    AND public.is_driver_active_trip_snapshot_row_eligible(t)
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    v_status := lower(coalesce(v_trip.status, ''));
    v_arrived_at := coalesce(v_trip.pickup_arrived_at, v_trip.arrived_at);

    SELECT
      COALESCE(fps.no_show_wait_time_minutes, 4),
      COALESCE(fps.no_show_apply_after_arrival_only, true)
    INTO v_no_show_wait_min, v_no_show_apply_after_arrival
    FROM public.fare_pricing_settings fps
    WHERE fps.service_area_id = v_trip.service_area_id
      AND (v_trip.vehicle_type_id IS NULL OR fps.vehicle_type_id = v_trip.vehicle_type_id)
    ORDER BY fps.vehicle_type_id NULLS LAST
    LIMIT 1;

    IF v_arrived_at IS NOT NULL
       AND v_trip.started_at IS NULL
       AND v_status IN (
         'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
         'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
       )
    THEN
      v_eligible_at := v_arrived_at
        + make_interval(mins => GREATEST(0, ceil(v_no_show_wait_min)::int));
      v_remaining_seconds := GREATEST(
        0,
        floor(extract(epoch from (v_eligible_at - v_server_now)))::int
      );
      v_can_mark := (v_server_now >= v_eligible_at)
        AND (NOT v_no_show_apply_after_arrival OR v_arrived_at IS NOT NULL);
    END IF;

    IF v_status IN (
      'accepted', 'confirmed', 'driver_assigned', 'assigned',
      'en_route', 'en_route_to_pickup', 'en_route_pickup',
      'driver_en_route', 'enroute_to_pickup', 'driver_arriving'
    ) THEN
      v_actions := '["arrive_pickup","driver_cancel"]'::jsonb;
    ELSIF v_status IN (
      'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
      'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
    ) THEN
      v_actions := jsonb_strip_nulls(jsonb_build_array(
        'start_trip',
        'driver_cancel',
        CASE WHEN v_can_mark THEN 'passenger_no_show' ELSE NULL END
      ));
    ELSIF v_status IN (
      'in_progress', 'started', 'on_trip', 'ongoing', 'trip_started',
      'pickup_in_progress', 'en_route_to_dropoff', 'en_route_destination',
      'en_route_dropoff', 'en_route_to_stop', 'en_route_stop'
    ) THEN
      v_actions := '["arrive_stop","next_stop","complete_trip","driver_cancel"]'::jsonb;
    ELSE
      v_actions := '[]'::jsonb;
    END IF;

    v_passenger_id := v_trip.passenger_id;
    v_passenger_first_name := NULL;
    v_passenger_last_name := NULL;
    v_passenger_rating := NULL;
    v_passenger_trip_count := NULL;

    IF v_passenger_id IS NOT NULL THEN
      SELECT
        NULLIF(btrim(c.first_name), ''),
        NULLIF(btrim(c.last_name), '')
      INTO v_passenger_first_name, v_passenger_last_name
      FROM public.customers c
      WHERE c.id = v_passenger_id;

      SELECT s.avg_rating, s.total_trips
      INTO v_passenger_rating, v_passenger_trip_count
      FROM public.get_customer_trip_stats(v_passenger_id) s;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', ts.id,
          'trip_id', ts.trip_id,
          'stop_index', ts.stop_index,
          'type', ts.type,
          'address', ts.address,
          'lat', ts.lat,
          'lng', ts.lng,
          'latitude', ts.lat,
          'longitude', ts.lng,
          'status', ts.status,
          'arrived_at', ts.arrived_at,
          'completed_at', ts.completed_at,
          'waiting_charge_active', ts.waiting_charge_active,
          'waiting_started_at', ts.waiting_started_at,
          'waiting_stopped_at', ts.waiting_stopped_at
        )
        ORDER BY ts.stop_index
      ),
      '[]'::jsonb
    )
    INTO v_stops
    FROM public.trip_stops ts
    WHERE ts.trip_id = v_trip.id;

    v_active := jsonb_build_object(
      'id', v_trip.id,
      'trip_id', v_trip.id,
      'public_trip_id', COALESCE(NULLIF(trim(v_trip.trip_number::text), ''), substring(v_trip.id::text, 1, 8)),
      'status', v_trip.status,
      'dispatch_status', v_trip.dispatch_status,
      'trip_version', v_trip.trip_version,
      'pricing_version', v_trip.pricing_version,
      'fare_revision_number', v_trip.fare_revision_number,
      'driver_id', v_trip.driver_id,
      'confirmed_driver_id', v_trip.confirmed_driver_id,
      'passenger_id', v_passenger_id,
      'passenger_first_name', v_passenger_first_name,
      'passenger_last_name', v_passenger_last_name,
      'passenger_name', NULLIF(btrim(COALESCE(v_trip.passenger_name, '')), ''),
      'passenger_rating', v_passenger_rating,
      'passenger_trip_count', v_passenger_trip_count,
      'arrived_at', v_trip.arrived_at,
      'pickup_arrived_at', v_trip.pickup_arrived_at,
      'started_at', v_trip.started_at,
      'completed_at', v_trip.completed_at,
      'current_stop_index', v_trip.current_stop_index,
      'pickup_waiting_started_at', v_trip.pickup_waiting_started_at,
      'pickup_paid_waiting_started_at', v_trip.pickup_paid_waiting_started_at,
      'free_wait_expires_at', v_trip.free_wait_expires_at,
      'pickup_waiting_admin_config', v_trip.pickup_waiting_admin_config,
      'admin_waiting_config_snapshot', v_trip.pickup_waiting_admin_config,
      'pickup_waiting_charge_pence', v_trip.pickup_waiting_charge_pence,
      'pickup_waiting_finalized_at', v_trip.pickup_waiting_finalized_at,
      'pickup_waiting_intervals_charged', v_trip.pickup_waiting_intervals_charged,
      'pickup_waiting_chargeable_seconds', v_trip.pickup_waiting_chargeable_seconds,
      'pickup_waiting_last_tick_at', v_trip.pickup_waiting_last_tick_at,
      'waiting_charge_pence', v_trip.waiting_charge_pence,
      'total_waiting_charge_pence', v_trip.total_waiting_charge_pence,
      'stop_waiting_charge_pence', v_trip.stop_waiting_charge_pence,
      'stop_charge_total_pence', v_trip.stop_charge_total_pence,
      'locked_base_fare_pence', v_trip.locked_base_fare_pence,
      'final_fare_pence', v_trip.final_fare_pence,
      'final_customer_fare_pence', v_trip.final_customer_fare_pence,
      'grace_period_expired_at', v_trip.grace_period_expired_at,
      'service_area_id', v_trip.service_area_id,
      'vehicle_type_id', v_trip.vehicle_type_id,
      'pickup_address', left(COALESCE(v_trip.pickup_address::text, ''), 160),
      'dropoff_address', left(COALESCE(v_trip.dropoff_address::text, ''), 160),
      'pickup_latitude', v_trip.pickup_latitude
    ) || jsonb_build_object(
      'pickup_longitude', v_trip.pickup_longitude,
      'dropoff_latitude', v_trip.dropoff_latitude,
      'dropoff_longitude', v_trip.dropoff_longitude,
      'payment_method', v_trip.payment_method,
      'payment_status', v_trip.payment_status,
      'driver_net_pence', COALESCE(
        NULLIF(v_trip.driver_net_pence, 0),
        NULLIF(v_trip.driver_net_before_tip_pence, 0),
        NULLIF(v_trip.accepted_driver_offer_fare_pence, 0)
      ),
      'currency_code', COALESCE(v_trip.currency_code, v_trip.offer_currency, 'GBP'),
      'stack_position', v_trip.stack_position,
      'is_queued', (v_trip.status = 'queued'),
      'customer_live_location_allowed', (
        v_status IN (
          'accepted', 'confirmed', 'assigned', 'driver_assigned',
          'en_route', 'en_route_to_pickup', 'en_route_pickup',
          'driver_en_route', 'driver_arriving', 'arrived', 'arrived_at_pickup',
          'at_pickup', 'pickup_waiting', 'waiting', 'driver_arrived',
          'waiting_at_pickup', 'in_progress', 'started', 'on_trip', 'ongoing',
          'pickup_in_progress', 'at_stop', 'en_route_to_stop', 'en_route_stop',
          'en_route_to_dropoff', 'en_route_destination'
        )
      ),
      'can_mark_no_show', v_can_mark,
      'no_show_eligible', v_can_mark,
      'no_show_eligible_at', v_eligible_at,
      'no_show_remaining_seconds', v_remaining_seconds,
      'permitted_actions', v_actions,
      'trip_stops', v_stops,
      'stops', v_stops
    ) || jsonb_build_object(
      -- Accepted-offer financial SSOT (MK-260817-008). Passthrough only.
      -- Never substitute final_fare_pence / customer fare.
      'accepted_ride_offer_id', v_trip.accepted_ride_offer_id,
      'accepted_commission_percent', v_trip.accepted_commission_percent,
      'accepted_dispatch_wave', v_trip.accepted_dispatch_wave,
      'accepted_dispatch_round', v_trip.accepted_dispatch_round,
      -- Pickup note SSOT — trips.special_instructions (Customer/Corporate).
      'special_instructions', NULLIF(left(btrim(COALESCE(v_trip.special_instructions::text, '')), 1000), '')
    );
  ELSE
    v_active := NULL;
  END IF;

  SELECT COALESCE(public.get_driver_queued_trips(), '[]'::jsonb)
  INTO v_queued;

  RETURN jsonb_build_object(
    'server_now', v_server_now,
    'driver_id', v_driver_id,
    'active_trip', v_active,
    'queued_trips', v_queued
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() TO authenticated, service_role;


INSERT INTO _verify_results
SELECT 'draft_has_lifecycle_order',
  CASE WHEN pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure)
    LIKE '%driver_active_trip_snapshot_lifecycle_rank(t.status) ASC%' THEN 'yes' ELSE 'no' END;
INSERT INTO _verify_results
SELECT 'draft_has_row_eligible',
  CASE WHEN pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure)
    LIKE '%is_driver_active_trip_snapshot_row_eligible(t)%' THEN 'yes' ELSE 'no' END;
INSERT INTO _verify_results
SELECT 'draft_security',
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_driver_active_trip_snapshot'
  AND pg_get_function_identity_arguments(p.oid)='';
INSERT INTO _verify_results
SELECT 'draft_search_path', coalesce(array_to_string(p.proconfig,','),'')
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_driver_active_trip_snapshot'
  AND pg_get_function_identity_arguments(p.oid)='';
INSERT INTO _verify_results
SELECT 'draft_args', pg_get_function_identity_arguments(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname='get_driver_active_trip_snapshot';
INSERT INTO _verify_results
SELECT 'draft_response_keys',
  CASE WHEN d LIKE '%server_now%' AND d LIKE '%active_trip%' AND d LIKE '%queued_trips%'
    AND d LIKE '%driver_id%' AND d LIKE '%permitted_actions%' AND d LIKE '%trip_stops%'
    AND d LIKE '%accepted_ride_offer_id%' AND d LIKE '%special_instructions%'
  THEN 'compatible' ELSE 'broken' END
FROM (SELECT pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure) d) s;
INSERT INTO _verify_results
SELECT 'draft_grant_authenticated',
  CASE WHEN has_function_privilege('authenticated', 'public.get_driver_active_trip_snapshot()', 'EXECUTE')
    THEN 'yes' ELSE 'no' END;
INSERT INTO _verify_results
SELECT 'draft_grant_service_role',
  CASE WHEN has_function_privilege('service_role', 'public.get_driver_active_trip_snapshot()', 'EXECUTE')
    THEN 'yes' ELSE 'no' END;
INSERT INTO _verify_results
SELECT 'draft_rpc_no_trip_update',
  CASE WHEN pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure)
    ~* 'UPDATE[[:space:]]+trips' THEN 'FAIL' ELSE 'ok' END;
INSERT INTO _verify_results
SELECT 'mk_status', status || '|' || coalesce(scheduled_status,'') || '|' || coalesce(gross_fare_pence,0)::text || '|' || id::text
FROM trips WHERE trip_number = 'MK-261114-002';

-- === ISOLATED EXECUTION SUITE ===

-- Isolated PostgreSQL execution suite for MK-261114-002 snapshot priority.
-- Exercises immutable helpers + the same eligibility/ORDER BY the draft RPC uses.
-- Does not mutate production trips.
-- Run after loading helpers from the draft (or inside a rolled-back txn).

CREATE OR REPLACE FUNCTION public.t_ok(cond boolean, label text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF cond IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: %', label;
  END IF;
  INSERT INTO _verify_results VALUES ('pass:' || label, 'PASS')
  ON CONFLICT (step) DO UPDATE SET detail = EXCLUDED.detail;
  RETURN 'PASS: ' || label;
END;
$$;

-- Scalar eligibility mirror of is_driver_active_trip_snapshot_row_eligible
-- for fixture rows that are not typed as public.trips.
CREATE OR REPLACE FUNCTION public.t_snap_eligible(
  p_status text,
  p_scheduled_status text,
  p_is_scheduled boolean,
  p_dispatch_mode text,
  p_scheduled_at timestamptz,
  p_jit timestamptz DEFAULT NULL,
  p_started_journey timestamptz DEFAULT NULL,
  p_checked_in timestamptz DEFAULT NULL,
  p_pickup_arrived timestamptz DEFAULT NULL,
  p_arrived timestamptz DEFAULT NULL,
  p_started timestamptz DEFAULT NULL,
  p_ack_status text DEFAULT NULL,
  p_ack_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT
    public.is_driver_active_trip_snapshot_status(p_status)
    AND NOT public.is_driver_active_trip_snapshot_unactivated_scheduled(
      p_status, p_scheduled_status, p_is_scheduled, p_dispatch_mode, p_scheduled_at,
      p_jit, p_started_journey, p_checked_in, p_pickup_arrived, p_arrived, p_started,
      p_ack_status, p_ack_at
    );
$$;

SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('scheduled'), '1/5 scheduled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('scheduled_committed'), 'scheduled_committed excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('searching'), 'searching excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('broadcasting'), 'broadcasting excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('pending'), 'pending excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('queued'), '10 queued excluded from active');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('completed'), '6 completed excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('cancelled'), 'cancelled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('customer_cancelled'), 'customer_cancelled excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('no_show'), 'no_show excluded');
SELECT t_ok(NOT public.is_driver_active_trip_snapshot_status('expired'), 'expired excluded');

SELECT t_ok(public.is_driver_active_trip_snapshot_status('assigned'), 'assigned allowed (not scheduled)');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('driver_assigned'), 'driver_assigned allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('accepted'), 'accepted allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_pickup'), 'en_route_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_pickup'), 'en_route_to_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('at_pickup'), 'at_pickup allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('arrived'), 'arrived allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('in_progress'), 'in_progress allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_stop'), 'en_route_stop allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_stop'), 'en_route_to_stop allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('at_stop'), 'at_stop allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_destination'), 'en_route_destination allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('en_route_to_dropoff'), 'en_route_to_dropoff allowed');
SELECT t_ok(public.is_driver_active_trip_snapshot_status('pickup_in_progress'), 'pickup_in_progress allowed');

CREATE TEMP TABLE snap_candidates (
  id text PRIMARY KEY,
  driver_id text,
  confirmed_driver_id text,
  status text NOT NULL,
  scheduled_status text,
  is_scheduled boolean,
  dispatch_mode text,
  scheduled_at timestamptz,
  jit_at timestamptz,
  started_journey_at timestamptz,
  checked_in_at timestamptz,
  pickup_arrived_at timestamptz,
  arrived_at timestamptz,
  started_at timestamptz,
  ack_status text,
  ack_at timestamptz,
  updated_at timestamptz NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION public.t_pick_active(p_driver text)
RETURNS text
LANGUAGE sql
AS $$
  SELECT id
  FROM snap_candidates t
  WHERE (t.driver_id = p_driver OR t.confirmed_driver_id = p_driver)
    AND public.t_snap_eligible(
      t.status, t.scheduled_status, t.is_scheduled, t.dispatch_mode, t.scheduled_at,
      t.jit_at, t.started_journey_at, t.checked_in_at, t.pickup_arrived_at,
      t.arrived_at, t.started_at, t.ack_status, t.ack_at
    )
  ORDER BY
    public.driver_active_trip_snapshot_lifecycle_rank(t.status) ASC,
    t.updated_at DESC NULLS LAST
  LIMIT 1;
$$;

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-progress', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '1 hour'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now() - interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') = 'live-progress', '1 in_progress beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-arrived', 'D1', 'D1', 'at_pickup', NULL, false, 'instant', NULL, now() - interval '30 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-arrived', '2 arrived beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-heading', 'D1', 'D1', 'en_route_to_pickup', NULL, false, 'instant', NULL, now() - interval '20 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-heading', '3 heading beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-stop', 'D1', 'D1', 'at_stop', NULL, false, 'instant', NULL, now() - interval '15 minutes'),
  ('future-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-stop', '4 at_stop beats newer scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('future-a', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now()),
  ('future-b', 'D1', 'D1', 'scheduled_committed', 'driver_assigned', true, 'scheduled', now() + interval '9 hours', now() - interval '5 minutes');
SELECT t_ok(public.t_pick_active('D1') IS NULL, '5 scheduled-only empty active');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('done', 'D1', 'D1', 'completed', NULL, false, 'instant', NULL, now()),
  ('cx', 'D1', 'D1', 'cancelled', NULL, false, 'instant', NULL, now() - interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') IS NULL, '6 terminal-only empty active');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('activated', 'D1', 'D1', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '30 minutes', now(), now()),
  ('other-future', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', NULL, now() + interval '1 minute');
SELECT t_ok(public.t_pick_active('D1') = 'activated', '7 activated scheduled restored');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('phase4', 'D1', 'D1', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '25 minutes', now(), now() - interval '2 minutes'),
  ('still-scheduled', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', NULL, now());
SELECT t_ok(public.t_pick_active('D1') = 'phase4', '8 phase4 activation preserved');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, ack_status, ack_at, updated_at
) VALUES
  ('phase5', 'D1', 'D1', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '20 minutes', now(), 'acknowledged', now(), now() - interval '1 minutes'),
  ('future', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', NULL, NULL, NULL, now());
SELECT t_ok(public.t_pick_active('D1') = 'phase5', '9 phase5 departure ack preserved');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('active', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '10 minutes'),
  ('queued-stack', 'D1', 'D1', 'queued', NULL, false, 'instant', NULL, now());
SELECT t_ok(public.t_pick_active('D1') = 'active', '10 active preferred over queued');
SELECT t_ok(
  EXISTS (SELECT 1 FROM snap_candidates WHERE id = 'queued-stack' AND status = 'queued'),
  '10 queued row remains available for get_driver_queued_trips'
);

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('rematched', 'D2', 'D2', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '15 minutes', now(), now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, '11 previous driver cannot restore rematch');
SELECT t_ok(public.t_pick_active('D2') = 'rematched', '11 new driver restores rematch');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('other', 'D2', 'D2', 'in_progress', NULL, false, 'instant', NULL, now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, '12 unrelated driver empty');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('cold-active', 'D1', 'D1', 'at_pickup', NULL, false, 'instant', NULL, now() - interval '5 minutes'),
  ('cold-sched', 'D1', 'D1', 'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'cold-active', '13 cold start restores active');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('older-progress', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '40 minutes'),
  ('newer-assigned', 'D1', 'D1', 'driver_assigned', NULL, false, 'instant', NULL, now()),
  ('mid-heading', 'D1', 'D1', 'en_route_to_pickup', NULL, false, 'instant', NULL, now() - interval '5 minutes');
SELECT t_ok(public.t_pick_active('D1') = 'older-progress', '14 deterministic in_progress wins');
SELECT t_ok(
  (SELECT count(*) FROM snap_candidates t
    WHERE public.t_snap_eligible(
      t.status, t.scheduled_status, t.is_scheduled, t.dispatch_mode, t.scheduled_at,
      t.jit_at, t.started_journey_at, t.checked_in_at, t.pickup_arrived_at,
      t.arrived_at, t.started_at, t.ack_status, t.ack_at
    )) = 3,
  '14 no automatic trip mutation (3 active rows remain)'
);

SELECT t_ok(
  ARRAY['server_now','driver_id','active_trip','queued_trips']::text[]
    = ARRAY['server_now','driver_id','active_trip','queued_trips']::text[],
  '15 top-level response keys stable'
);
SELECT t_ok(
  public.is_driver_active_trip_snapshot_status('assigned')
  AND NOT public.is_driver_active_trip_snapshot_status('scheduled'),
  'assigned allowlisted; scheduled not'
);

-- 1. Legacy accept_scheduled_ride writer shape
SELECT t_ok(
  NOT public.t_snap_eligible(
    'accepted', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E1 accept_scheduled_ride future accepted excluded'
);

SELECT t_ok(
  NOT public.t_snap_eligible(
    'assigned', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E2 future assigned scheduled excluded'
);

SELECT t_ok(
  NOT public.t_snap_eligible(
    'confirmed', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E3 future confirmed scheduled excluded'
);

SELECT t_ok(
  NOT public.t_snap_eligible(
    'driver_assigned', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E4 future driver_assigned status excluded'
);

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('live-progress', 'D1', 'D1', 'in_progress', NULL, false, 'instant', NULL, now() - interval '1 hour'),
  ('legacy-accepted', 'D1', 'D1', 'accepted', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'live-progress', 'E5 active beats newer legacy accepted scheduled');

DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, updated_at
) VALUES
  ('cold-live', 'D1', 'D1', 'en_route_to_pickup', NULL, false, 'instant', NULL, now() - interval '3 minutes'),
  ('cold-accepted', 'D1', 'D1', 'accepted', 'driver_assigned', true, 'scheduled', now() + interval '8 hours', now());
SELECT t_ok(public.t_pick_active('D1') = 'cold-live', 'E6 cold start restores genuine active over accepted scheduled');

SELECT t_ok(
  public.t_snap_eligible('accepted', NULL, false, 'instant', NULL),
  'E7 genuine instant accepted included'
);

SELECT t_ok(
  public.t_snap_eligible('assigned', NULL, false, NULL, NULL),
  'E8 genuine instant assigned included'
);

-- 9. Valid scheduled activation before pickup time
SELECT t_ok(
  public.t_snap_eligible(
    'en_route_to_pickup', 'driver_en_route', true, 'scheduled',
    now() + interval '45 minutes', now() -- jit_at
  ),
  'E9 activated before pickup time included'
);

-- 10. Phase 4 legacy activation recovery
SELECT t_ok(
  public.t_snap_eligible(
    'en_route_to_pickup', 'driver_en_route', true, 'scheduled',
    now() + interval '30 minutes', now(), NULL, now() -- checked_in
  ),
  'E10 phase4 activation recovery preserved'
);

-- 11. Phase 5 heading then active recovery (ack + en_route)
SELECT t_ok(
  public.t_snap_eligible(
    'en_route_to_pickup', 'driver_en_route', true, 'scheduled',
    now() + interval '25 minutes', now(), NULL, now(), NULL, NULL, NULL,
    'acknowledged', now()
  ),
  'E11 phase5 heading active recovery preserved'
);

-- Phase 5 armed but NOT headed → still unactivated reservation
SELECT t_ok(
  NOT public.t_snap_eligible(
    'accepted', 'awaiting_activation_accept', true, 'scheduled',
    now() + interval '25 minutes'
  ),
  'E11b phase5 awaiting ack still excluded'
);

-- 12. Scheduled-to-instant conversion
SELECT t_ok(
  public.t_snap_eligible(
    'accepted', 'converted_to_instant', true, 'instant', now() + interval '10 minutes'
  ),
  'E12 converted_to_instant included'
);

-- 13. Rematched scheduled — ownership (already covered); previous driver empty
DELETE FROM snap_candidates;
INSERT INTO snap_candidates (
  id, driver_id, confirmed_driver_id, status, scheduled_status, is_scheduled,
  dispatch_mode, scheduled_at, jit_at, updated_at
) VALUES
  ('sched-rematch', 'D2', 'D2', 'en_route_to_pickup', 'driver_en_route', true, 'scheduled', now() + interval '20 minutes', now(), now());
SELECT t_ok(public.t_pick_active('D1') IS NULL, 'E13 rematched scheduled previous driver empty');

-- 14. Queued stacked scheduled commitment
SELECT t_ok(
  NOT public.t_snap_eligible(
    'queued', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E14 queued stacked scheduled excluded'
);

-- 15. Past-due but unactivated reservation
SELECT t_ok(
  NOT public.t_snap_eligible(
    'accepted', 'driver_assigned', true, 'scheduled', now() - interval '15 minutes'
  ),
  'E15 past-due unactivated reservation excluded'
);

-- 16. Missing activation metadata but genuine in_progress must not be suppressed
SELECT t_ok(
  public.t_snap_eligible(
    'in_progress', NULL, true, 'scheduled', now() + interval '10 minutes'
    -- no jit / journey / arrival stamps
  ),
  'E16 inconsistent metadata does not suppress in_progress'
);

-- Marketplace writer shape (MK path): status=scheduled remains excluded
SELECT t_ok(
  NOT public.t_snap_eligible(
    'scheduled', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E marketplace scheduled commitment excluded'
);

-- Admin assign unactivated driver_assigned status
SELECT t_ok(
  NOT public.t_snap_eligible(
    'driver_assigned', 'driver_assigned', true, 'scheduled', now() + interval '8 hours'
  ),
  'E admin_assign unactivated driver_assigned excluded'
);

DROP FUNCTION IF EXISTS public.t_pick_active(text);
DROP FUNCTION IF EXISTS public.t_snap_eligible(text, text, boolean, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz);
DROP FUNCTION IF EXISTS public.t_ok(boolean, text);
-- === ROLLBACK SQL TEST ===
-- Rollback for draft 20270222250000_driver_active_trip_snapshot_priority.sql
-- Restores currently deployed production selection (updated_at DESC, includes scheduled).
-- REVIEW ONLY companion — apply only if the forward draft was applied and must be reverted.

DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_row_eligible(public.trips);
DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_unactivated_scheduled(text, text, boolean, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz);
DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_scheduled_activated(text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, timestamptz);
DROP FUNCTION IF EXISTS public.is_driver_active_trip_snapshot_status(text);
DROP FUNCTION IF EXISTS public.driver_active_trip_snapshot_lifecycle_rank(text);

CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_trip record;
  v_queued jsonb;
  v_server_now timestamptz := now();
  v_no_show_wait_min numeric := 4;
  v_no_show_apply_after_arrival boolean := true;
  v_arrived_at timestamptz;
  v_status text;
  v_eligible_at timestamptz;
  v_remaining_seconds integer := 0;
  v_can_mark boolean := false;
  v_actions jsonb := '[]'::jsonb;
  v_active jsonb;
  v_passenger_id uuid;
  v_passenger_first_name text;
  v_passenger_last_name text;
  v_passenger_rating numeric;
  v_passenger_trip_count integer;
  v_stops jsonb := '[]'::jsonb;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT t.*
  INTO v_trip
  FROM public.trips t
  WHERE (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
    AND t.status IS DISTINCT FROM 'queued'
    AND t.status NOT IN (
      'completed', 'cancelled', 'canceled', 'customer_cancelled',
      'driver_cancelled', 'no_show', 'expired', 'declined', 'failed'
    )
  ORDER BY t.updated_at DESC NULLS LAST
  LIMIT 1;

  IF FOUND THEN
    v_status := lower(coalesce(v_trip.status, ''));
    v_arrived_at := coalesce(v_trip.pickup_arrived_at, v_trip.arrived_at);

    SELECT
      COALESCE(fps.no_show_wait_time_minutes, 4),
      COALESCE(fps.no_show_apply_after_arrival_only, true)
    INTO v_no_show_wait_min, v_no_show_apply_after_arrival
    FROM public.fare_pricing_settings fps
    WHERE fps.service_area_id = v_trip.service_area_id
      AND (v_trip.vehicle_type_id IS NULL OR fps.vehicle_type_id = v_trip.vehicle_type_id)
    ORDER BY fps.vehicle_type_id NULLS LAST
    LIMIT 1;

    IF v_arrived_at IS NOT NULL
       AND v_trip.started_at IS NULL
       AND v_status IN (
         'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
         'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
       )
    THEN
      v_eligible_at := v_arrived_at
        + make_interval(mins => GREATEST(0, ceil(v_no_show_wait_min)::int));
      v_remaining_seconds := GREATEST(
        0,
        floor(extract(epoch from (v_eligible_at - v_server_now)))::int
      );
      v_can_mark := (v_server_now >= v_eligible_at)
        AND (NOT v_no_show_apply_after_arrival OR v_arrived_at IS NOT NULL);
    END IF;

    IF v_status IN (
      'accepted', 'confirmed', 'driver_assigned', 'en_route', 'en_route_to_pickup',
      'driver_en_route', 'enroute_to_pickup', 'driver_arriving'
    ) THEN
      v_actions := '["arrive_pickup","driver_cancel"]'::jsonb;
    ELSIF v_status IN (
      'arrived', 'arrived_pickup', 'arrived_at_pickup', 'at_pickup',
      'pickup_waiting', 'waiting', 'driver_arrived', 'waiting_at_pickup'
    ) THEN
      v_actions := jsonb_strip_nulls(jsonb_build_array(
        'start_trip',
        'driver_cancel',
        CASE WHEN v_can_mark THEN 'passenger_no_show' ELSE NULL END
      ));
    ELSIF v_status IN ('in_progress', 'started', 'on_trip', 'ongoing') THEN
      v_actions := '["arrive_stop","next_stop","complete_trip","driver_cancel"]'::jsonb;
    ELSE
      v_actions := '[]'::jsonb;
    END IF;

    v_passenger_id := v_trip.passenger_id;
    v_passenger_first_name := NULL;
    v_passenger_last_name := NULL;
    v_passenger_rating := NULL;
    v_passenger_trip_count := NULL;

    IF v_passenger_id IS NOT NULL THEN
      SELECT
        NULLIF(btrim(c.first_name), ''),
        NULLIF(btrim(c.last_name), '')
      INTO v_passenger_first_name, v_passenger_last_name
      FROM public.customers c
      WHERE c.id = v_passenger_id;

      SELECT s.avg_rating, s.total_trips
      INTO v_passenger_rating, v_passenger_trip_count
      FROM public.get_customer_trip_stats(v_passenger_id) s;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', ts.id,
          'trip_id', ts.trip_id,
          'stop_index', ts.stop_index,
          'type', ts.type,
          'address', ts.address,
          'lat', ts.lat,
          'lng', ts.lng,
          'latitude', ts.lat,
          'longitude', ts.lng,
          'status', ts.status,
          'arrived_at', ts.arrived_at,
          'completed_at', ts.completed_at,
          'waiting_charge_active', ts.waiting_charge_active,
          'waiting_started_at', ts.waiting_started_at,
          'waiting_stopped_at', ts.waiting_stopped_at
        )
        ORDER BY ts.stop_index
      ),
      '[]'::jsonb
    )
    INTO v_stops
    FROM public.trip_stops ts
    WHERE ts.trip_id = v_trip.id;

    v_active := jsonb_build_object(
      'id', v_trip.id,
      'trip_id', v_trip.id,
      'public_trip_id', COALESCE(NULLIF(trim(v_trip.trip_number::text), ''), substring(v_trip.id::text, 1, 8)),
      'status', v_trip.status,
      'dispatch_status', v_trip.dispatch_status,
      'trip_version', v_trip.trip_version,
      'pricing_version', v_trip.pricing_version,
      'fare_revision_number', v_trip.fare_revision_number,
      'driver_id', v_trip.driver_id,
      'confirmed_driver_id', v_trip.confirmed_driver_id,
      'passenger_id', v_passenger_id,
      'passenger_first_name', v_passenger_first_name,
      'passenger_last_name', v_passenger_last_name,
      'passenger_name', NULLIF(btrim(COALESCE(v_trip.passenger_name, '')), ''),
      'passenger_rating', v_passenger_rating,
      'passenger_trip_count', v_passenger_trip_count,
      'arrived_at', v_trip.arrived_at,
      'pickup_arrived_at', v_trip.pickup_arrived_at,
      'started_at', v_trip.started_at,
      'completed_at', v_trip.completed_at,
      'current_stop_index', v_trip.current_stop_index,
      'pickup_waiting_started_at', v_trip.pickup_waiting_started_at,
      'pickup_paid_waiting_started_at', v_trip.pickup_paid_waiting_started_at,
      'free_wait_expires_at', v_trip.free_wait_expires_at,
      'pickup_waiting_admin_config', v_trip.pickup_waiting_admin_config,
      'admin_waiting_config_snapshot', v_trip.pickup_waiting_admin_config,
      'pickup_waiting_charge_pence', v_trip.pickup_waiting_charge_pence,
      'pickup_waiting_finalized_at', v_trip.pickup_waiting_finalized_at,
      'pickup_waiting_intervals_charged', v_trip.pickup_waiting_intervals_charged,
      'pickup_waiting_chargeable_seconds', v_trip.pickup_waiting_chargeable_seconds,
      'pickup_waiting_last_tick_at', v_trip.pickup_waiting_last_tick_at,
      'waiting_charge_pence', v_trip.waiting_charge_pence,
      'total_waiting_charge_pence', v_trip.total_waiting_charge_pence,
      'stop_waiting_charge_pence', v_trip.stop_waiting_charge_pence,
      'stop_charge_total_pence', v_trip.stop_charge_total_pence,
      'locked_base_fare_pence', v_trip.locked_base_fare_pence,
      'final_fare_pence', v_trip.final_fare_pence,
      'final_customer_fare_pence', v_trip.final_customer_fare_pence,
      'grace_period_expired_at', v_trip.grace_period_expired_at,
      'service_area_id', v_trip.service_area_id,
      'vehicle_type_id', v_trip.vehicle_type_id,
      'pickup_address', left(COALESCE(v_trip.pickup_address::text, ''), 160),
      'dropoff_address', left(COALESCE(v_trip.dropoff_address::text, ''), 160),
      'pickup_latitude', v_trip.pickup_latitude
    ) || jsonb_build_object(
      'pickup_longitude', v_trip.pickup_longitude,
      'dropoff_latitude', v_trip.dropoff_latitude,
      'dropoff_longitude', v_trip.dropoff_longitude,
      'payment_method', v_trip.payment_method,
      'payment_status', v_trip.payment_status,
      'driver_net_pence', COALESCE(
        NULLIF(v_trip.driver_net_pence, 0),
        NULLIF(v_trip.driver_net_before_tip_pence, 0),
        NULLIF(v_trip.accepted_driver_offer_fare_pence, 0)
      ),
      'currency_code', COALESCE(v_trip.currency_code, v_trip.offer_currency, 'GBP'),
      'stack_position', v_trip.stack_position,
      'is_queued', (v_trip.status = 'queued'),
      'customer_live_location_allowed', (
        v_status IN (
          'accepted', 'confirmed', 'en_route', 'en_route_to_pickup',
          'driver_en_route', 'driver_arriving', 'arrived', 'arrived_at_pickup',
          'at_pickup', 'pickup_waiting', 'waiting', 'driver_arrived'
        )
      ),
      'can_mark_no_show', v_can_mark,
      'no_show_eligible', v_can_mark,
      'no_show_eligible_at', v_eligible_at,
      'no_show_remaining_seconds', v_remaining_seconds,
      'permitted_actions', v_actions,
      'trip_stops', v_stops,
      'stops', v_stops
    ) || jsonb_build_object(
      -- Accepted-offer financial SSOT (MK-260817-008). Passthrough only.
      -- Never substitute final_fare_pence / customer fare.
      'accepted_ride_offer_id', v_trip.accepted_ride_offer_id,
      'accepted_commission_percent', v_trip.accepted_commission_percent,
      'accepted_dispatch_wave', v_trip.accepted_dispatch_wave,
      'accepted_dispatch_round', v_trip.accepted_dispatch_round,
      -- Pickup note SSOT — trips.special_instructions (Customer/Corporate).
      'special_instructions', NULLIF(left(btrim(COALESCE(v_trip.special_instructions::text, '')), 1000), '')
    );
  ELSE
    v_active := NULL;
  END IF;

  SELECT COALESCE(public.get_driver_queued_trips(), '[]'::jsonb)
  INTO v_queued;

  RETURN jsonb_build_object(
    'server_now', v_server_now,
    'driver_id', v_driver_id,
    'active_trip', v_active,
    'queued_trips', v_queued
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() TO authenticated, service_role;


INSERT INTO _verify_results
SELECT 'after_rollback_updated_at_order',
  CASE WHEN pg_get_functiondef('public.get_driver_active_trip_snapshot()'::regprocedure)
    LIKE '%ORDER BY t.updated_at DESC NULLS LAST%' THEN 'yes' ELSE 'no' END;
INSERT INTO _verify_results
SELECT 'after_rollback_helpers_gone',
  CASE WHEN to_regprocedure('public.is_driver_active_trip_snapshot_status(text)') IS NULL
    AND to_regprocedure('public.is_driver_active_trip_snapshot_row_eligible(trips)') IS NULL
  THEN 'yes' ELSE 'no' END;
INSERT INTO _verify_results
SELECT 'pass_count', count(*)::text FROM _verify_results WHERE step LIKE 'pass:%';
SELECT jsonb_object_agg(step, detail) AS report FROM _verify_results;
ROLLBACK;
