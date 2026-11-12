-- Isolated fixture schema for scheduled create-parity migrations (NOT production).
-- Disposable Postgres only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.payment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid,
  status text,
  provider_state text,
  provider_order_id text,
  payment_provider text DEFAULT 'revolut',
  client_action_id text,
  currency text DEFAULT 'gbp',
  service_area_id uuid,
  authorised_amount_pence int,
  estimated_total_pence int,
  buffer_pence int DEFAULT 0,
  capture_deadline timestamptz,
  capture_deadline_source text,
  capture_deadline_updated_at timestamptz,
  capture_deadline_observed_at timestamptz,
  hold_release_state text,
  released_at timestamptz,
  captured_at timestamptz,
  trip_id uuid,
  booking_snapshot jsonb DEFAULT '{}'::jsonb,
  fare_snapshot jsonb DEFAULT '{}'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  failure_reason text,
  payment_method text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id uuid,
  passenger_name text,
  passenger_phone text,
  pickup_address text,
  pickup_latitude numeric,
  pickup_longitude numeric,
  dropoff_address text,
  dropoff_latitude numeric,
  dropoff_longitude numeric,
  stops jsonb DEFAULT '[]'::jsonb,
  total_stops int,
  vehicle_type_id uuid,
  estimated_fare numeric,
  estimated_total_pence int,
  final_customer_fare_pence int,
  gross_fare_pence int,
  offer_discount_pence int,
  discount_pence int,
  locked_base_fare_pence int,
  authorised_amount_pence int,
  preauth_buffer_pence int,
  estimated_distance_km numeric,
  estimated_duration_minutes int,
  special_instructions text,
  is_scheduled boolean DEFAULT false,
  scheduled_at timestamptz,
  payment_method text,
  payment_type text,
  trip_type text,
  status text,
  dispatch_mode text,
  scheduled_status text,
  scheduled_broadcast_at timestamptz,
  scheduled_convert_at timestamptz,
  scheduled_hold_reason text,
  scheduled_publish_attempts int DEFAULT 0,
  currency_code text,
  service_area_id uuid,
  booking_source text,
  payment_session_id uuid,
  payment_provider text,
  provider_order_id text,
  payment_status text,
  payment_state text,
  client_action_id text,
  driver_id uuid,
  confirmed_driver_id uuid,
  broadcast_enabled boolean DEFAULT true,
  airport_charge_pence int,
  pending_release_kind text,
  pending_release_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  started_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_scheduled_hold_reason_check;
ALTER TABLE public.trips
  ADD CONSTRAINT trips_scheduled_hold_reason_check
  CHECK (
    scheduled_hold_reason IS NULL
    OR scheduled_hold_reason = ANY (ARRAY[
      'publication_pending','publication_retry','publication_exhausted',
      'airport_pricing','payment_gate','manual','manual_trip',
      'admin_exceptional','unknown_historical'
    ])
  );

CREATE OR REPLACE FUNCTION public.compute_scheduled_dispatch_anchors(
  p_scheduled_at timestamptz,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE(scheduled_broadcast_at timestamptz, scheduled_convert_at timestamptz)
LANGUAGE sql
STABLE
AS $$
  SELECT
    p_scheduled_at - interval '13 minutes' AS scheduled_broadcast_at,
    p_scheduled_at - interval '9 minutes' AS scheduled_convert_at;
$$;

CREATE OR REPLACE FUNCTION public.required_capture_coverage_until(
  p_scheduled_at timestamptz,
  p_duration_minutes int DEFAULT 30,
  p_safety_minutes int DEFAULT 360
)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT p_scheduled_at
    + make_interval(mins => COALESCE(p_duration_minutes, 30))
    + make_interval(mins => COALESCE(p_safety_minutes, 360));
$$;

CREATE OR REPLACE FUNCTION public.passenger_has_live_immediate_trip(
  p_passenger_id uuid,
  p_ignore uuid
) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

CREATE OR REPLACE FUNCTION public.resolve_booking_customer_payable_pence(
  p_booking jsonb,
  p_fare jsonb,
  p_estimated int,
  p_authorised int
)
RETURNS TABLE(
  customer_payable_pence int,
  gross_fare_pence int,
  discount_pence int
) LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(
      NULLIF(p_fare->>'customer_payable_pence','')::int,
      NULLIF(p_booking->>'customer_payable_pence','')::int,
      p_estimated,
      p_authorised,
      500
    ),
    COALESCE(
      NULLIF(p_fare->>'gross_fare_pence','')::int,
      NULLIF(p_booking->>'gross_fare_pence','')::int,
      500
    ),
    COALESCE(NULLIF(p_fare->>'discount_pence','')::int, 0);
$$;

CREATE OR REPLACE FUNCTION public.ensure_trip_stops_for_assignment(p_trip_id uuid)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$;

-- Stub matching retirement patch marker in 20270218130100.
CREATE OR REPLACE FUNCTION public.admin_scheduled_emergency_mutate(
  v_action text,
  v_trip_id uuid,
  v_actor uuid,
  v_reason text,
  v_payload jsonb,
  v_meta jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF char_length(v_reason) < 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  END IF;

  -- Staff JWT path: enforce page + action. Service-role trusted after Edge RBAC.
  RETURN jsonb_build_object('success', true, 'action', v_action);
END;
$fn$;

-- Placeholder lifecycle before migration REPLACE.
CREATE OR REPLACE FUNCTION public.enforce_scheduled_trip_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_scheduled_trip_lifecycle ON public.trips;
CREATE TRIGGER trg_enforce_scheduled_trip_lifecycle
  BEFORE INSERT OR UPDATE ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_scheduled_trip_lifecycle();
