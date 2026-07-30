-- Permanently drop retired scan_and_go schema, RPCs, triggers, and trip columns.
-- Historical migrations retain prior SQL for history only; this is the live cutover.

-- 1) Drop retired lock trigger(s) on trips
DROP TRIGGER IF EXISTS tr_validate_scan_go_lock ON public.trips;

-- 2) Drop all public functions whose names contain scan_go (any signature)
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname ILIKE '%scan_go%'
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;

-- Explicit drops for known typed RPCs (idempotent if already removed above)
DROP FUNCTION IF EXISTS public.acquire_scan_go_driver_hold(uuid, uuid, uuid, uuid, text, integer) CASCADE;
DROP FUNCTION IF EXISTS public.convert_scan_go_driver_hold(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.expire_scan_go_driver_holds() CASCADE;
DROP FUNCTION IF EXISTS public.get_scan_go_driver_public_lookup(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.release_scan_go_driver_hold(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.scan_go_vehicle_is_blocked(text) CASCADE;
DROP FUNCTION IF EXISTS public.scan_go_vehicle_is_bookable(text) CASCADE;
DROP FUNCTION IF EXISTS public.scan_go_vehicle_status_rank(text) CASCADE;
DROP FUNCTION IF EXISTS public.validate_scan_go_lock() CASCADE;

-- 3) Drop holds table
DROP TABLE IF EXISTS public.scan_go_driver_holds CASCADE;

-- 4) Recreate views that selected retired columns before dropping them
DROP VIEW IF EXISTS public.available_scheduled_jobs;

-- 5) Drop retired columns from trips
ALTER TABLE public.trips DROP COLUMN IF EXISTS scan_go CASCADE;
ALTER TABLE public.trips DROP COLUMN IF EXISTS locked_driver_id CASCADE;
ALTER TABLE public.trips DROP COLUMN IF EXISTS qr_session_id CASCADE;

-- 6) Restore available_scheduled_jobs without qr_session_id
CREATE VIEW public.available_scheduled_jobs AS
SELECT
  id,
  passenger_id,
  passenger_name,
  passenger_phone,
  driver_id,
  confirmed_driver_id,
  pickup_address,
  pickup_latitude,
  pickup_longitude,
  dropoff_address,
  dropoff_latitude,
  dropoff_longitude,
  stops,
  fare,
  estimated_fare,
  estimated_distance_km,
  estimated_duration_minutes,
  surge_multiplier,
  currency,
  currency_code,
  payment_method,
  payment_type,
  payment_status,
  status,
  trip_type,
  trip_code,
  job_type,
  special_instructions,
  is_scheduled,
  scheduled_at,
  client_action_id,
  created_at,
  updated_at,
  started_at,
  completed_at,
  driver_location_lat,
  driver_location_lng,
  total_stops,
  current_stop_index,
  scheduled_status,
  dispatch_mode,
  scheduled_broadcast_at,
  scheduled_convert_at,
  confirm_deadline_at,
  pre_assigned_driver_id,
  driver_confirm_deadline_at,
  escalation_status,
  pickup_zone_id,
  dropoff_zone_id,
  service_area_id,
  dispatch_status,
  current_broadcast_round,
  max_broadcast_rounds,
  broadcast_started_at,
  last_broadcast_at,
  service_area_code,
  sequence_no,
  trip_number,
  arrived_at,
  vehicle_type,
  gross_fare_pence,
  commission_pence,
  driver_net_pence,
  stripe_payment_intent_id,
  scheduled_accepted_at,
  check_in_reminder_sent_at,
  current_offer_driver_id,
  current_offer_expires_at,
  COALESCE((
    SELECT count(*)::bigint
    FROM scheduled_offer_attempts
    WHERE scheduled_offer_attempts.trip_id = t.id
      AND (scheduled_offer_attempts.status = ANY (ARRAY['declined'::text, 'timeout'::text]))
  ), 0::bigint) AS declined_count
FROM trips t
WHERE dispatch_mode = 'scheduled'::text
  AND (scheduled_status = ANY (ARRAY['broadcasting'::text, 'scheduled'::text, 'awaiting_confirmation'::text]))
  AND driver_id IS NULL
  AND confirmed_driver_id IS NULL
  AND scheduled_at > now()
  AND (status <> ALL (ARRAY[
    'completed'::text,
    'cancelled'::text,
    'customer_cancelled'::text,
    'driver_cancelled'::text,
    'no_show'::text,
    'expired'::text,
    'expired_no_driver'::text
  ]));

COMMENT ON TABLE public.trips IS
  'Customer trips. Retired scan_and_go columns (scan_go, locked_driver_id, qr_session_id) removed 2026-09-03.';
