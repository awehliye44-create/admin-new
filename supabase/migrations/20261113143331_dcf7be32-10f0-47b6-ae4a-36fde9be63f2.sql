CREATE TABLE public.trip_action_location_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  action text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  driver_lat double precision,
  driver_lng double precision,
  driver_location_source text,
  driver_location_at timestamptz,
  driver_location_age_seconds integer,
  driver_accuracy_m double precision,
  target_type text,
  target_lat double precision,
  target_lng double precision,
  distance_to_target_m double precision,
  passenger_lat double precision,
  passenger_lng double precision,
  passenger_location_at timestamptz,
  passenger_accuracy_m double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_action_location_evidence_action_chk CHECK (action IN ('arrived_pickup','no_show','trip_completed')),
  CONSTRAINT trip_action_location_evidence_unique UNIQUE (trip_id, action)
);

CREATE INDEX trip_action_location_evidence_trip_idx ON public.trip_action_location_evidence(trip_id);

GRANT SELECT ON public.trip_action_location_evidence TO authenticated;
GRANT ALL ON public.trip_action_location_evidence TO service_role;

ALTER TABLE public.trip_action_location_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Trip History staff can view location evidence"
ON public.trip_action_location_evidence
FOR SELECT TO authenticated
USING (public.staff_has_page_access('trip-history'));

-- Evidence is immutable once written.
CREATE OR REPLACE FUNCTION public.trip_action_location_evidence_block_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Trip location evidence is immutable';
END;
$$;

CREATE TRIGGER trip_action_location_evidence_immutable
BEFORE UPDATE ON public.trip_action_location_evidence
FOR EACH ROW EXECUTE FUNCTION public.trip_action_location_evidence_block_update();

CREATE OR REPLACE FUNCTION public.capture_trip_action_location_evidence(p_trip public.trips, p_action text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver uuid := COALESCE(p_trip.confirmed_driver_id, p_trip.driver_id);
  v_now timestamptz := now();
  v_lat double precision; v_lng double precision; v_at timestamptz; v_acc double precision; v_src text;
  p_lat double precision; p_lng double precision; p_at timestamptz;
  t_lat double precision; t_lng double precision; t_type text;
  c_lat double precision; c_lng double precision; c_at timestamptz; c_acc double precision;
  v_dist double precision;
BEGIN
  IF v_driver IS NOT NULL THEN
    SELECT latitude, longitude, gps_recorded_at, accuracy_m
      INTO v_lat, v_lng, v_at, v_acc
      FROM public.trip_driver_live_location
     WHERE trip_id = p_trip.id AND driver_id = v_driver;
    IF v_lat IS NOT NULL THEN v_src := 'trip_gps'; END IF;

    SELECT lat, lng, COALESCE(last_gps_sample_at, last_location_at)
      INTO p_lat, p_lng, p_at
      FROM public.driver_presence WHERE driver_id = v_driver;

    IF p_lat IS NOT NULL AND p_lng IS NOT NULL
       AND (v_lat IS NULL OR (p_at IS NOT NULL AND (v_at IS NULL OR p_at > v_at))) THEN
      v_lat := p_lat; v_lng := p_lng; v_at := p_at; v_acc := NULL; v_src := 'driver_presence';
    END IF;
  END IF;

  IF p_action = 'trip_completed' THEN
    t_type := 'dropoff'; t_lat := p_trip.dropoff_latitude; t_lng := p_trip.dropoff_longitude;
  ELSE
    t_type := 'pickup'; t_lat := p_trip.pickup_latitude; t_lng := p_trip.pickup_longitude;
  END IF;

  SELECT latitude, longitude, updated_at, accuracy
    INTO c_lat, c_lng, c_at, c_acc
    FROM public.customer_live_locations WHERE trip_id = p_trip.id;

  IF v_lat IS NOT NULL AND t_lat IS NOT NULL THEN
    v_dist := 6371000 * 2 * asin(sqrt(
      power(sin(radians(t_lat - v_lat) / 2), 2) +
      cos(radians(v_lat)) * cos(radians(t_lat)) * power(sin(radians(t_lng - v_lng) / 2), 2)
    ));
  END IF;

  INSERT INTO public.trip_action_location_evidence (
    trip_id, driver_id, action, recorded_at,
    driver_lat, driver_lng, driver_location_source, driver_location_at, driver_location_age_seconds, driver_accuracy_m,
    target_type, target_lat, target_lng, distance_to_target_m,
    passenger_lat, passenger_lng, passenger_location_at, passenger_accuracy_m
  ) VALUES (
    p_trip.id, v_driver, p_action, v_now,
    v_lat, v_lng, v_src, v_at,
    CASE WHEN v_at IS NULL THEN NULL ELSE GREATEST(0, EXTRACT(EPOCH FROM (v_now - v_at)))::int END,
    v_acc,
    t_type, t_lat, t_lng, v_dist,
    c_lat, c_lng, c_at, c_acc
  )
  ON CONFLICT (trip_id, action) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  -- Evidence capture must never block the driver's trip action.
  RAISE WARNING 'TRIP_ACTION_LOCATION_EVIDENCE_FAILED trip=% action=% err=%', p_trip.id, p_action, SQLERRM;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_trip_action_location_evidence(public.trips, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trips_capture_action_location_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF COALESCE(OLD.pickup_arrived_at, OLD.arrived_at) IS NULL
     AND COALESCE(NEW.pickup_arrived_at, NEW.arrived_at) IS NOT NULL THEN
    PERFORM public.capture_trip_action_location_evidence(NEW, 'arrived_pickup');
  END IF;

  IF lower(COALESCE(NEW.status, '')) IS DISTINCT FROM lower(COALESCE(OLD.status, '')) THEN
    IF lower(NEW.status) = 'no_show' THEN
      PERFORM public.capture_trip_action_location_evidence(NEW, 'no_show');
    ELSIF lower(NEW.status) = 'completed' THEN
      PERFORM public.capture_trip_action_location_evidence(NEW, 'trip_completed');
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.trips_capture_action_location_evidence() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trips_capture_action_location_evidence
AFTER UPDATE ON public.trips
FOR EACH ROW
WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  OR OLD.pickup_arrived_at IS DISTINCT FROM NEW.pickup_arrived_at
  OR OLD.arrived_at IS DISTINCT FROM NEW.arrived_at
)
EXECUTE FUNCTION public.trips_capture_action_location_evidence();