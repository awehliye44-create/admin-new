-- MK-260916-038: available_scheduled_jobs must not list pre-STEP-2 scheduled rows.
-- Driver Requested uses list_driver_own_scheduled_jobs; this view is the leftover
-- PostgREST surface and previously included scheduled_status='scheduled'.

CREATE OR REPLACE VIEW public.available_scheduled_jobs AS
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
    scheduled_accepted_at,
    check_in_reminder_sent_at,
    current_offer_driver_id,
    current_offer_expires_at,
    COALESCE((
      SELECT count(*) AS count
      FROM scheduled_offer_attempts
      WHERE scheduled_offer_attempts.trip_id = t.id
        AND (scheduled_offer_attempts.status = ANY (ARRAY['declined'::text, 'timeout'::text]))
    ), 0::bigint) AS declined_count
FROM trips t
WHERE public.scheduled_marketplace_is_open(
  t.dispatch_mode,
  t.scheduled_status,
  t.status,
  t.scheduled_at,
  t.scheduled_broadcast_at,
  t.created_at,
  t.driver_id,
  t.confirmed_driver_id,
  now()
);

ALTER VIEW public.available_scheduled_jobs SET (security_invoker = on);

COMMENT ON VIEW public.available_scheduled_jobs IS
  'MK-260916-038: unassigned scheduled marketplace jobs after STEP 2. Same gate as list_driver_own_scheduled_jobs.';
