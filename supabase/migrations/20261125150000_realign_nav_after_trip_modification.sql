-- MK-260922-001: after trip modification rebuilds trip_stops, realign
-- trips.current_stop_index / current_stop_id so Driver arrive_stop / drive_to_next
-- still resolve a row. Apply previously updated total_stops only.

CREATE OR REPLACE FUNCTION public.realign_trip_nav_after_modification(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_status text;
  v_nav_id uuid;
  v_nav_idx int;
  v_pre_pickup boolean;
BEGIN
  SELECT lower(COALESCE(status, '')) INTO v_status
  FROM public.trips
  WHERE id = p_trip_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_pre_pickup := v_status IN (
    'accepted', 'confirmed', 'driver_assigned', 'en_route', 'en_route_to_pickup',
    'enroute_to_pickup', 'driver_en_route', 'driver_arriving', 'arrived',
    'arrived_pickup', 'arrived_at_pickup', 'at_pickup', 'pickup_waiting', 'waiting'
  );

  IF v_pre_pickup THEN
    SELECT id, stop_index INTO v_nav_id, v_nav_idx
    FROM public.trip_stops
    WHERE trip_id = p_trip_id AND type = 'pickup'
    ORDER BY stop_index
    LIMIT 1;
  ELSE
    -- In progress: first incomplete non-pickup (intermediate or dropoff).
    SELECT id, stop_index INTO v_nav_id, v_nav_idx
    FROM public.trip_stops
    WHERE trip_id = p_trip_id
      AND type IS DISTINCT FROM 'pickup'
      AND COALESCE(status, '') NOT IN ('completed', 'skipped')
    ORDER BY stop_index
    LIMIT 1;
  END IF;

  IF v_nav_id IS NULL THEN
    SELECT id, stop_index INTO v_nav_id, v_nav_idx
    FROM public.trip_stops
    WHERE trip_id = p_trip_id
    ORDER BY stop_index DESC
    LIMIT 1;
  END IF;

  IF v_nav_id IS NULL THEN
    RETURN;
  END IF;

  -- Ensure exactly one 'current' navigation target among incomplete stops.
  UPDATE public.trip_stops
  SET status = CASE
        WHEN id = v_nav_id AND COALESCE(status, '') NOT IN ('completed', 'skipped', 'arrived')
          THEN 'current'
        WHEN id <> v_nav_id AND status = 'current'
          THEN 'pending'
        ELSE status
      END,
      updated_at = now()
  WHERE trip_id = p_trip_id
    AND COALESCE(status, '') NOT IN ('completed', 'skipped');

  UPDATE public.trips
  SET current_stop_index = v_nav_idx,
      current_stop_id = v_nav_id,
      current_destination_index = v_nav_idx,
      updated_at = now()
  WHERE id = p_trip_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_approved_trip_change_from_request(p_req trip_change_requests)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  snapshot jsonb;
  stop_rec jsonb;
  new_index int;
  pickup_rec jsonb;
  dropoff_rec jsonb;
  intermediate_stops jsonb[];
  i int;
  existing_pickup_arrived_at timestamptz;
  existing_pickup_status text;
  v_fare_preview jsonb;
  v_locked_ids uuid[];
  v_trip_status text;
BEGIN
  -- Hard payment gate: no apply without confirmation when fare increases.
  IF COALESCE(p_req.fare_delta_pence, 0) > 0
     AND COALESCE(p_req.payment_status, '') IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'payment_confirmation_required'
      USING ERRCODE = 'P0001';
  END IF;

  -- Already applied (idempotent).
  IF p_req.status = 'applied' THEN
    RETURN;
  END IF;

  -- Terminal trips cannot be modified (cancel/complete race with payment confirm).
  SELECT lower(COALESCE(status, '')) INTO v_trip_status
  FROM public.trips
  WHERE id = p_req.trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip_not_found_for_modification'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_trip_status IN (
    'completed', 'cancelled', 'canceled', 'no_show', 'expired',
    'failed', 'driver_cancelled_terminal'
  ) THEN
    RAISE EXCEPTION 'trip_terminal_cannot_modify: %', v_trip_status
      USING ERRCODE = 'P0001';
  END IF;

  snapshot := p_req.after_route_snapshot;

  IF p_req.change_type IN ('add_stop', 'remove_stop', 'change_dropoff', 'reorder_stops') THEN
    pickup_rec := NULL;
    dropoff_rec := NULL;
    intermediate_stops := ARRAY[]::jsonb[];

    IF snapshot->'stops' IS NOT NULL AND jsonb_array_length(snapshot->'stops') > 0 THEN
      FOR i IN 0..jsonb_array_length(snapshot->'stops') - 1 LOOP
        stop_rec := snapshot->'stops'->i;
        IF stop_rec->>'type' = 'pickup' THEN
          pickup_rec := stop_rec;
        ELSIF stop_rec->>'type' = 'dropoff' THEN
          dropoff_rec := stop_rec;
        ELSE
          intermediate_stops := array_append(intermediate_stops, stop_rec);
        END IF;
      END LOOP;
    END IF;

    -- Preserve completed/skipped/arrived stops forever (past-stop lock).
    SELECT COALESCE(array_agg(id), ARRAY[]::uuid[])
    INTO v_locked_ids
    FROM trip_stops
    WHERE trip_id = p_req.trip_id
      AND (
        status IN ('completed', 'skipped', 'arrived')
        OR type = 'pickup' AND status IN ('completed', 'arrived', 'skipped')
      );

    SELECT arrived_at, status INTO existing_pickup_arrived_at, existing_pickup_status
    FROM trip_stops WHERE trip_id = p_req.trip_id AND type = 'pickup' LIMIT 1;

    DELETE FROM trip_stops
    WHERE trip_id = p_req.trip_id
      AND status NOT IN ('completed', 'skipped', 'arrived')
      AND id <> ALL (v_locked_ids);

    SELECT COALESCE(MAX(stop_index), -1) + 1 INTO new_index
    FROM trip_stops WHERE trip_id = p_req.trip_id;

    IF pickup_rec IS NOT NULL AND NOT EXISTS (SELECT 1 FROM trip_stops WHERE trip_id = p_req.trip_id AND type = 'pickup') THEN
      INSERT INTO trip_stops (trip_id, stop_index, type, status, address, lat, lng, arrived_at)
      VALUES (
        p_req.trip_id, new_index, 'pickup',
        COALESCE(existing_pickup_status, 'pending'),
        pickup_rec->>'address',
        (pickup_rec->>'lat')::numeric,
        (pickup_rec->>'lng')::numeric,
        existing_pickup_arrived_at
      );
      new_index := new_index + 1;
    END IF;

    IF intermediate_stops IS NOT NULL AND array_length(intermediate_stops, 1) > 0 THEN
      FOR i IN 1..array_length(intermediate_stops, 1) LOOP
        stop_rec := intermediate_stops[i];
        IF EXISTS (
          SELECT 1 FROM trip_stops ts
          WHERE ts.trip_id = p_req.trip_id
            AND ts.status IN ('completed', 'skipped', 'arrived')
            AND ts.type = 'stop'
            AND ts.address IS NOT DISTINCT FROM stop_rec->>'address'
        ) THEN
          CONTINUE;
        END IF;

        INSERT INTO trip_stops (trip_id, stop_index, type, status, address, lat, lng)
        VALUES (
          p_req.trip_id, new_index, 'stop', 'pending',
          stop_rec->>'address',
          (stop_rec->>'lat')::numeric,
          (stop_rec->>'lng')::numeric
        );
        new_index := new_index + 1;
      END LOOP;
    END IF;

    IF dropoff_rec IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM trip_stops
        WHERE trip_id = p_req.trip_id
          AND type = 'dropoff'
          AND status IN ('completed', 'skipped', 'arrived')
      ) THEN
        INSERT INTO trip_stops (trip_id, stop_index, type, status, address, lat, lng)
        VALUES (
          p_req.trip_id, new_index, 'dropoff', 'pending',
          dropoff_rec->>'address',
          (dropoff_rec->>'lat')::numeric,
          (dropoff_rec->>'lng')::numeric
        );
        new_index := new_index + 1;
      END IF;
    END IF;

    UPDATE trips SET total_stops = new_index, updated_at = now() WHERE id = p_req.trip_id;
    -- MK-260922-001: keep Driver stop-workflow indexed at a real row after rebuild.
    PERFORM public.realign_trip_nav_after_modification(p_req.trip_id);
  END IF;

  v_fare_preview := snapshot->'fare_preview';
  PERFORM public.apply_trip_modification_to_trip(
    p_req.trip_id,
    p_req.change_type,
    p_req.fare_delta_pence,
    COALESCE((v_fare_preview->>'new_fare_pence')::int, p_req.new_fare_pence),
    p_req.new_distance_meters,
    p_req.new_duration_seconds,
    p_req.before_route_snapshot,
    snapshot,
    v_fare_preview
  );

  UPDATE public.trip_change_requests
  SET status = 'applied',
      updated_at = now()
  WHERE id = p_req.id
    AND status IS DISTINCT FROM 'applied';
END;
$function$;
