-- Ensure assignment stop seeding includes intermediate vias from trips.stops.
-- Previously only pickup+dropoff were inserted, so Driver showed Stop 1 from
-- trips.stops JSON but arrive_stop failed: "No intermediate stop to arrive at."

CREATE OR REPLACE FUNCTION public.ensure_trip_stops_for_assignment(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_stop_count integer;
  v_via_count integer;
  v_intermediate_count integer;
  v_elem jsonb;
  v_idx integer;
  v_address text;
  v_lat double precision;
  v_lng double precision;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::integer INTO v_stop_count
  FROM public.trip_stops WHERE trip_id = p_trip_id;

  SELECT COUNT(*)::integer INTO v_intermediate_count
  FROM public.trip_stops WHERE trip_id = p_trip_id AND type = 'stop';

  v_via_count := COALESCE(jsonb_array_length(to_jsonb(v_trip.stops)), 0);

  IF v_stop_count = 0 THEN
    INSERT INTO public.trip_stops (trip_id, stop_index, type, address, lat, lng, status)
    VALUES (
      p_trip_id, 0, 'pickup',
      COALESCE(v_trip.pickup_address, 'Pickup'),
      COALESCE(v_trip.pickup_latitude, 0),
      COALESCE(v_trip.pickup_longitude, 0),
      'pending'
    );

    v_idx := 1;
    IF v_via_count > 0 THEN
      FOR v_elem IN SELECT * FROM jsonb_array_elements(to_jsonb(v_trip.stops))
      LOOP
        v_lat := NULLIF(v_elem->>'lat', '')::double precision;
        IF v_lat IS NULL THEN
          v_lat := NULLIF(v_elem->>'latitude', '')::double precision;
        END IF;
        v_lng := NULLIF(v_elem->>'lng', '')::double precision;
        IF v_lng IS NULL THEN
          v_lng := NULLIF(v_elem->>'longitude', '')::double precision;
        END IF;
        IF v_lat IS NULL OR v_lng IS NULL THEN
          CONTINUE;
        END IF;
        v_address := COALESCE(
          NULLIF(trim(v_elem->>'address'), ''),
          NULLIF(trim(v_elem->>'formatted_address'), ''),
          NULLIF(trim(v_elem->>'name'), ''),
          'Stop ' || v_idx::text
        );
        IF v_address ~ '^ChIJ' THEN
          v_address := 'Stop ' || v_idx::text;
        END IF;
        INSERT INTO public.trip_stops (trip_id, stop_index, type, address, lat, lng, status)
        VALUES (p_trip_id, v_idx, 'stop', v_address, v_lat, v_lng, 'pending');
        v_idx := v_idx + 1;
      END LOOP;
    END IF;

    INSERT INTO public.trip_stops (trip_id, stop_index, type, address, lat, lng, status)
    VALUES (
      p_trip_id, v_idx, 'dropoff',
      COALESCE(v_trip.dropoff_address, 'Dropoff'),
      COALESCE(v_trip.dropoff_latitude, 0),
      COALESCE(v_trip.dropoff_longitude, 0),
      'pending'
    );

    UPDATE public.trips
    SET total_stops = GREATEST(COALESCE(total_stops, 0), v_idx + 1, 2),
        updated_at = now()
    WHERE id = p_trip_id;
    RETURN;
  END IF;

  IF v_via_count > 0 AND v_intermediate_count = 0 THEN
    UPDATE public.trip_stops
    SET stop_index = stop_index + v_via_count, updated_at = now()
    WHERE trip_id = p_trip_id AND type = 'dropoff';

    v_idx := 1;
    FOR v_elem IN SELECT * FROM jsonb_array_elements(to_jsonb(v_trip.stops))
    LOOP
      v_lat := NULLIF(v_elem->>'lat', '')::double precision;
      IF v_lat IS NULL THEN
        v_lat := NULLIF(v_elem->>'latitude', '')::double precision;
      END IF;
      v_lng := NULLIF(v_elem->>'lng', '')::double precision;
      IF v_lng IS NULL THEN
        v_lng := NULLIF(v_elem->>'longitude', '')::double precision;
      END IF;
      IF v_lat IS NULL OR v_lng IS NULL THEN
        CONTINUE;
      END IF;
      v_address := COALESCE(
        NULLIF(trim(v_elem->>'address'), ''),
        NULLIF(trim(v_elem->>'formatted_address'), ''),
        NULLIF(trim(v_elem->>'name'), ''),
        'Stop ' || v_idx::text
      );
      IF v_address ~ '^ChIJ' THEN
        v_address := 'Stop ' || v_idx::text;
      END IF;
      INSERT INTO public.trip_stops (trip_id, stop_index, type, address, lat, lng, status)
      VALUES (
        p_trip_id, v_idx, 'stop', v_address, v_lat, v_lng,
        CASE WHEN v_idx = 1 THEN 'current' ELSE 'pending' END
      );
      v_idx := v_idx + 1;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM public.trip_stops
      WHERE trip_id = p_trip_id AND type = 'pickup' AND status = 'completed'
    ) THEN
      UPDATE public.trip_stops
      SET status = 'pending', updated_at = now()
      WHERE trip_id = p_trip_id AND type = 'dropoff';
      UPDATE public.trip_stops
      SET status = 'current', updated_at = now()
      WHERE trip_id = p_trip_id AND type = 'stop' AND stop_index = 1;
      UPDATE public.trips
      SET current_stop_index = 1,
          total_stops = GREATEST(COALESCE(total_stops, 0), v_idx + 1, 2),
          updated_at = now()
      WHERE id = p_trip_id;
    ELSE
      UPDATE public.trips
      SET total_stops = GREATEST(COALESCE(total_stops, 0), v_idx + 1, 2),
          updated_at = now()
      WHERE id = p_trip_id;
    END IF;
  END IF;
END;
$$;
