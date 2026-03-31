
CREATE OR REPLACE FUNCTION public.ops_detect_repeated_guest_submissions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT t.passenger_phone, t.passenger_name, count(*) as submission_count,
           min(t.id::text)::uuid as first_trip_id, t.service_area_id
    FROM public.trips t
    WHERE t.booking_source = 'guest'
      AND t.created_at > now() - interval '30 minutes'
      AND t.passenger_phone IS NOT NULL
    GROUP BY t.passenger_phone, t.passenger_name, t.service_area_id
    HAVING count(*) >= 3
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts oa
      WHERE oa.fingerprint = 'dup_guest_submit:' || COALESCE(r.passenger_phone, '') || ':' || date_trunc('hour', now())::text
        AND oa.status IN ('open', 'acknowledged')
    ) THEN
      PERFORM public.ops_upsert_alert(
        'dup_guest_submit:' || COALESCE(r.passenger_phone, '') || ':' || date_trunc('hour', now())::text,
        'duplication', 'warning', 'system', 'guest',
        'Repeated Guest Submissions',
        COALESCE(r.passenger_name, 'Unknown') || ' submitted ' || r.submission_count || ' bookings in 30 minutes',
        r.first_trip_id, NULL, NULL, NULL, NULL, NULL,
        jsonb_build_object('passenger_phone', r.passenger_phone, 'submission_count', r.submission_count)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;
