
CREATE OR REPLACE VIEW public.dispatchable_drivers AS
SELECT d.id AS driver_id,
    d.first_name,
    d.last_name,
    d.rating,
    d.current_trip_id,
    dp.status,
    dp.lat,
    dp.lng,
    dp.heading,
    dp.speed,
    dp.last_heartbeat_at,
    dp.last_location_at,
    dp.app_state,
    dp.platform,
    dp.push_token,
    EXTRACT(epoch FROM (now() - dp.last_heartbeat_at)) AS heartbeat_age_seconds
   FROM drivers d
     JOIN driver_presence dp ON d.id = dp.driver_id
  WHERE d.approval_status = 'approved'
    AND d.documents_approved = true
    AND d.current_trip_id IS NULL
    AND dp.status = 'online'
    AND dp.last_heartbeat_at > (now() - interval '1 minute')
    AND dp.push_token IS NOT NULL
    AND dp.lat IS NOT NULL
    AND dp.lng IS NOT NULL;
