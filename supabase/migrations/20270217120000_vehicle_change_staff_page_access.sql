-- Vehicle change requests: staff with Vehicles/Drivers page access can list and
-- review, matching vehicles table RLS. Previously only user_roles.admin could
-- SELECT / call admin_get / admin_decide — staff_profiles operators saw an empty
-- Vehicles page while driver RPCs still inserted pending rows.

BEGIN;

DROP POLICY IF EXISTS "Staff with vehicles or drivers page can read vehicle change requests"
  ON public.vehicle_change_requests;
CREATE POLICY "Staff with vehicles or drivers page can read vehicle change requests"
  ON public.vehicle_change_requests
  FOR SELECT
  TO authenticated
  USING (public.staff_has_any_page_access(ARRAY['vehicles', 'drivers']));

CREATE OR REPLACE FUNCTION public.admin_get_vehicle_change_review(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.vehicle_change_requests%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.vehicle_change_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_row.vehicle_id;

  RETURN jsonb_build_object(
    'ok', true,
    'request', public.vehicle_change_request_json(v_row)
      || jsonb_build_object('admin_notes', v_row.admin_notes,
                            'driver_id', v_row.driver_id,
                            'vehicle_id', v_row.vehicle_id,
                            'reviewed_document_ids', to_jsonb(v_row.reviewed_document_ids),
                            'confirmed_vehicle_type_ids', to_jsonb(v_row.confirmed_vehicle_type_ids)),
    'current_vehicle', CASE WHEN v_vehicle.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_vehicle.id,
      'make', v_vehicle.make,
      'model', v_vehicle.model,
      'year', v_vehicle.year,
      'colour', v_vehicle.color,
      'licence_plate', v_vehicle.license_plate,
      'approval_status', v_vehicle.approval_status,
      'capacity', v_vehicle.capacity,
      'belongs_to_driver', v_vehicle.driver_id = v_row.driver_id) END,
    'vehicle_documents', public.vehicle_change_applicable_documents(v_row.driver_id),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'vehicle_type_id', c.vehicle_type_id,
               'name', c.name,
               'slug', c.slug,
               'is_default', c.is_default,
               'driver_controllable', c.driver_controllable,
               'enabled', c.enabled)
             ORDER BY c.is_default DESC, c.name)
        FROM public.driver_effective_vehicle_categories(v_row.driver_id) c
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_decide_vehicle_change_request(
  p_request_id uuid,
  p_decision text,
  p_rejection_reason text DEFAULT NULL,
  p_admin_notes text DEFAULT NULL,
  p_reviewed_document_ids uuid[] DEFAULT NULL,
  p_enabled_vehicle_type_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.vehicle_change_requests%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_docs jsonb;
  v_doc jsonb;
  v_not_compliant jsonb := '[]'::jsonb;
  v_expected_ids uuid[];
  v_reviewed uuid[];
  v_enabled uuid[];
  v_reason text := NULLIF(btrim(coalesce(p_rejection_reason, '')), '');
  v_notes text := NULLIF(btrim(coalesce(p_admin_notes, '')), '');
  v_cat record;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DECISION');
  END IF;

  SELECT * INTO v_row FROM public.vehicle_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_DECIDED', 'status', v_row.status);
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = v_row.driver_id FOR UPDATE;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_row.vehicle_id FOR UPDATE;

  IF p_decision = 'reject' THEN
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'REJECTION_REASON_REQUIRED');
    END IF;

    UPDATE public.vehicle_change_requests
       SET status = 'rejected', rejection_reason = v_reason, admin_notes = v_notes,
           reviewed_at = now(), reviewed_by = v_uid
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    UPDATE public.drivers SET vehicle_edit_request_status = 'rejected' WHERE id = v_row.driver_id;

    INSERT INTO public.driver_inbox_messages (driver_id, type, title, body, metadata)
    VALUES (v_row.driver_id, 'vehicle_change', 'Vehicle change request rejected',
            'Your vehicle change request was not approved. Your current vehicle stays active. Reason: ' || v_reason,
            jsonb_build_object('request_id', v_row.id, 'status', 'rejected'));

    INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
    VALUES ('vehicle_change_request_rejected', v_uid, v_row.driver_id,
            jsonb_build_object('request_id', v_row.id, 'reason', v_reason));

    RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
  END IF;

  IF v_driver.id IS NULL OR v_driver.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_ACTIVE');
  END IF;
  IF v_vehicle.id IS NULL OR v_vehicle.driver_id IS DISTINCT FROM v_row.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_MISMATCH');
  END IF;
  IF v_vehicle.make IS DISTINCT FROM v_row.previous_make
     OR v_vehicle.model IS DISTINCT FROM v_row.previous_model
     OR v_vehicle.year IS DISTINCT FROM v_row.previous_year
     OR v_vehicle.color IS DISTINCT FROM v_row.previous_color
     OR v_vehicle.license_plate IS DISTINCT FROM v_row.previous_license_plate
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_CHANGED_SINCE_REQUEST');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate)
           = public.vehicle_licence_plate_key(v_row.requested_license_plate)
       AND other.driver_id IS DISTINCT FROM v_row.driver_id
       AND od.deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_CONFLICT');
  END IF;

  v_docs := public.vehicle_change_applicable_documents(v_row.driver_id);
  IF NOT COALESCE((v_docs->>'rules_available')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCUMENT_RULES_UNAVAILABLE',
      'detail', v_docs->>'code');
  END IF;
  FOR v_doc IN SELECT * FROM jsonb_array_elements(v_docs->'documents') LOOP
    IF v_doc->>'state' <> 'approved' OR v_doc->>'document_id' IS NULL THEN
      v_not_compliant := v_not_compliant || jsonb_build_array(
        jsonb_build_object('slug', v_doc->>'slug', 'state', v_doc->>'state'));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_not_compliant) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_DOCUMENTS_NOT_COMPLIANT',
      'documents', v_not_compliant);
  END IF;

  SELECT COALESCE(array_agg((d->>'document_id')::uuid ORDER BY d->>'document_id'), ARRAY[]::uuid[])
    INTO v_expected_ids
    FROM jsonb_array_elements(v_docs->'documents') d;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[])
    INTO v_reviewed
    FROM unnest(COALESCE(p_reviewed_document_ids, ARRAY[]::uuid[])) x;
  IF p_reviewed_document_ids IS NULL OR v_reviewed IS DISTINCT FROM v_expected_ids THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_DOCUMENTS_NOT_REVIEWED',
      'expected_document_ids', to_jsonb(v_expected_ids));
  END IF;

  IF p_enabled_vehicle_type_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CATEGORY_RECHECK_REQUIRED');
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[])
    INTO v_enabled
    FROM unnest(p_enabled_vehicle_type_ids) x;
  IF EXISTS (
    SELECT 1 FROM unnest(v_enabled) x
     WHERE NOT EXISTS (SELECT 1 FROM public.vehicle_types vt WHERE vt.id = x AND vt.is_active = true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNKNOWN_VEHICLE_CATEGORY');
  END IF;
  IF cardinality(v_enabled) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ELIGIBLE_CATEGORY');
  END IF;

  FOR v_cat IN SELECT * FROM public.driver_effective_vehicle_categories(v_row.driver_id) LOOP
    IF v_cat.enabled IS DISTINCT FROM (v_cat.vehicle_type_id = ANY (v_enabled)) THEN
      INSERT INTO public.driver_vehicle_categories (driver_id, vehicle_type_id, is_enabled)
      VALUES (v_row.driver_id, v_cat.vehicle_type_id, v_cat.vehicle_type_id = ANY (v_enabled))
      ON CONFLICT (driver_id, vehicle_type_id)
      DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now();
    END IF;
  END LOOP;

  UPDATE public.vehicles
     SET make = v_row.requested_make,
         model = v_row.requested_model,
         year = v_row.requested_year,
         color = v_row.requested_color,
         license_plate = v_row.requested_license_plate
   WHERE id = v_vehicle.id;

  UPDATE public.vehicle_change_requests
     SET status = 'approved', admin_notes = v_notes,
         reviewed_at = now(), reviewed_by = v_uid,
         reviewed_document_ids = v_expected_ids,
         confirmed_vehicle_type_ids = v_enabled
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  UPDATE public.drivers SET vehicle_edit_request_status = 'approved' WHERE id = v_row.driver_id;

  INSERT INTO public.driver_inbox_messages (driver_id, type, title, body, metadata)
  VALUES (v_row.driver_id, 'vehicle_change', 'Vehicle change approved',
          'Your vehicle details have been updated to ' || v_row.requested_make || ' '
            || v_row.requested_model || ' (' || v_row.requested_license_plate || ').',
          jsonb_build_object('request_id', v_row.id, 'status', 'approved'));

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_approved', v_uid, v_row.driver_id,
          jsonb_build_object('request_id', v_row.id,
                             'vehicle_id', v_vehicle.id,
                             'reviewed_document_ids', to_jsonb(v_expected_ids),
                             'enabled_vehicle_type_ids', to_jsonb(v_enabled)));

  RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_vehicle_change_review(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_decide_vehicle_change_request(uuid, text, text, text, uuid[], uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_vehicle_change_review(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_vehicle_change_request(uuid, text, text, text, uuid[], uuid[])
  TO authenticated, service_role;

COMMIT;
