-- Permanent fix: driver vehicle-change suspend (and other operational updates)
-- must not be blocked by check_vehicle_edit_allowed when identity fields are unchanged.
--
-- Bug: submit_driver_vehicle_change_request with p_suspend_previous=true UPDATE'd
-- operational_status → trigger raised "Vehicle is locked…" → PostgREST 500 →
-- Driver app mapped that to "Check your connection and try again."
--
-- Policy: identity fields stay locked for approved vehicles; operational fields
-- (status / trip-active / primary / suspended_reason) may change via SECURITY DEFINER RPCs.

CREATE OR REPLACE FUNCTION public.check_vehicle_edit_allowed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_can_edit boolean;
  v_identity_changed boolean;
BEGIN
  -- Skip check for admins
  IF has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  v_identity_changed :=
       NEW.make IS DISTINCT FROM OLD.make
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.year IS DISTINCT FROM OLD.year
    OR NEW.color IS DISTINCT FROM OLD.color
    OR NEW.license_plate IS DISTINCT FROM OLD.license_plate
    OR NEW.capacity IS DISTINCT FROM OLD.capacity
    OR NEW.vehicle_type_id IS DISTINCT FROM OLD.vehicle_type_id;

  -- Operational-only updates (suspend, primary, trip-active, archive) stay allowed.
  IF NOT v_identity_changed THEN
    RETURN NEW;
  END IF;

  SELECT can_driver_edit_vehicle(NEW.driver_id) INTO v_can_edit;

  IF NOT v_can_edit THEN
    RAISE EXCEPTION 'Vehicle is locked. Please submit a change request for admin approval.';
  END IF;

  RETURN NEW;
END;
$$;

-- Harden submit: never leak raw exceptions as PostgREST 500 / fake network errors.
CREATE OR REPLACE FUNCTION public.submit_driver_vehicle_change_request(
  p_make text,
  p_model text,
  p_year integer,
  p_color text,
  p_license_plate text,
  p_idempotency_key uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_suspend_previous boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_vehicle public.vehicles%ROWTYPE;
  v_existing public.vehicle_change_requests%ROWTYPE;
  v_row public.vehicle_change_requests%ROWTYPE;
  v_new public.vehicles%ROWTYPE;
  v_make text := btrim(regexp_replace(coalesce(p_make, ''), '\s+', ' ', 'g'));
  v_model text := btrim(regexp_replace(coalesce(p_model, ''), '\s+', ' ', 'g'));
  v_color text := btrim(regexp_replace(coalesce(p_color, ''), '\s+', ' ', 'g'));
  v_plate text := public.normalize_vehicle_licence_plate(p_license_plate);
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_max_year integer := extract(year FROM (now() AT TIME ZONE 'Europe/London'))::integer + 1;
  v_saved_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO v_driver_id
    FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL
   FOR UPDATE;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.vehicle_change_requests
     WHERE driver_id = v_driver_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true,
        'request', public.vehicle_change_request_json(v_existing));
    END IF;
  END IF;

  SELECT * INTO v_vehicle
    FROM public.vehicles v
   WHERE v.driver_id = v_driver_id
     AND v.operational_status NOT IN ('available_in_fleet', 'archived')
   ORDER BY v.is_trip_active DESC, v.is_primary DESC NULLS LAST, v.created_at ASC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_VEHICLE');
  END IF;
  IF COALESCE(v_vehicle.approval_status, '') <> 'approved'
     AND v_vehicle.operational_status <> 'suspended_under_repair' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_APPROVED');
  END IF;

  -- Reason is optional; only reject blank identity fields.
  IF v_make = '' OR v_model = '' OR v_color = '' OR length(v_plate) < 2 OR p_year IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', CASE
      WHEN v_make = '' THEN 'make'
      WHEN v_model = '' THEN 'model'
      WHEN p_year IS NULL THEN 'year'
      WHEN v_color = '' THEN 'colour'
      ELSE 'licence_plate' END);
  END IF;
  IF length(v_make) > 40 OR length(v_model) > 40 OR length(v_color) > 30 OR length(v_plate) > 12
     OR (v_reason IS NOT NULL AND length(v_reason) > 200) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;
  IF p_year < 1980 OR p_year > v_max_year THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'year');
  END IF;
  IF v_plate !~ '^[A-Z0-9 ]+$' OR length(public.vehicle_licence_plate_key(v_plate)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'licence_plate');
  END IF;

  IF lower(v_make) = lower(btrim(coalesce(v_vehicle.make, '')))
     AND lower(v_model) = lower(btrim(coalesce(v_vehicle.model, '')))
     AND p_year IS NOT DISTINCT FROM v_vehicle.year
     AND lower(v_color) = lower(btrim(coalesce(v_vehicle.color, '')))
     AND public.vehicle_licence_plate_key(v_plate) = public.vehicle_licence_plate_key(v_vehicle.license_plate)
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CHANGES');
  END IF;

  SELECT * INTO v_existing
    FROM public.vehicle_change_requests
   WHERE driver_id = v_driver_id AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_REQUEST_EXISTS',
      'request', public.vehicle_change_request_json(v_existing));
  END IF;

  SELECT count(*) INTO v_saved_count
    FROM public.vehicles v
   WHERE v.driver_id = v_driver_id
     AND v.operational_status NOT IN ('available_in_fleet', 'archived');
  IF v_saved_count >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_LIMIT_REACHED');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate) = public.vehicle_licence_plate_key(v_plate)
       AND other.driver_id IS DISTINCT FROM v_driver_id
       AND od.deleted_at IS NULL
       AND other.operational_status <> 'archived'
  ) OR EXISTS (
    SELECT 1
      FROM public.vehicle_change_requests other_req
     WHERE other_req.status = 'pending'
       AND other_req.driver_id <> v_driver_id
       AND public.vehicle_licence_plate_key(other_req.requested_license_plate) = public.vehicle_licence_plate_key(v_plate)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_CONFLICT');
  END IF;

  BEGIN
    INSERT INTO public.vehicles (
      driver_id, make, model, year, color, license_plate,
      capacity, vehicle_type_id, approval_status, is_primary, is_trip_active,
      operational_status, fleet_shared
    ) VALUES (
      v_driver_id, v_make, v_model, p_year, v_color, v_plate,
      COALESCE(v_vehicle.capacity, 4), v_vehicle.vehicle_type_id, 'pending', false, false,
      'active', false
    )
    RETURNING * INTO v_new;

    BEGIN
      INSERT INTO public.vehicle_change_requests (
        driver_id, vehicle_id, status,
        requested_make, requested_model, requested_year, requested_color, requested_license_plate,
        previous_make, previous_model, previous_year, previous_color, previous_license_plate,
        idempotency_key, reason, requested_vehicle_id, suspend_previous, change_kind
      ) VALUES (
        v_driver_id, v_vehicle.id, 'pending',
        v_make, v_model, p_year, v_color, v_plate,
        v_vehicle.make, v_vehicle.model, v_vehicle.year, v_vehicle.color, v_vehicle.license_plate,
        p_idempotency_key, v_reason, v_new.id, COALESCE(p_suspend_previous, false), 'replacement'
      )
      RETURNING * INTO v_row;
    EXCEPTION WHEN unique_violation THEN
      UPDATE public.vehicles SET operational_status = 'archived', is_trip_active = false
       WHERE id = v_new.id;
      SELECT * INTO v_existing
        FROM public.vehicle_change_requests
       WHERE driver_id = v_driver_id AND status = 'pending';
      RETURN jsonb_build_object('ok', false, 'code', 'PENDING_REQUEST_EXISTS',
        'request', CASE WHEN v_existing.id IS NULL THEN NULL
                        ELSE public.vehicle_change_request_json(v_existing) END);
    END;

    IF COALESCE(p_suspend_previous, false) THEN
      UPDATE public.vehicles
         SET operational_status = 'suspended_under_repair',
             is_trip_active = false,
             suspended_reason = v_reason,
             updated_at = now()
       WHERE id = v_vehicle.id;
    END IF;

    INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
    VALUES ('vehicle_change_request_submitted', v_uid, v_driver_id,
            jsonb_build_object(
              'request_id', v_row.id,
              'previous_vehicle_id', v_vehicle.id,
              'requested_vehicle_id', v_new.id,
              'suspend_previous', COALESCE(p_suspend_previous, false)
            ));

    RETURN jsonb_build_object('ok', true, 'idempotent', false,
      'request', public.vehicle_change_request_json(v_row));
  EXCEPTION
    WHEN OTHERS THEN
      -- Prefer structured codes; never force clients to treat SQL raises as "offline".
      IF SQLERRM LIKE 'VEHICLE_LIMIT_REACHED%' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_LIMIT_REACHED');
      END IF;
      IF SQLERRM ILIKE '%Vehicle is locked%' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_LOCKED');
      END IF;
      RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid, text, boolean) TO authenticated, service_role;
