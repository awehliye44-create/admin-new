-- Vehicle / document Admin management controls hardening.
-- Page RBAC on lifecycle RPCs; Set Active / Suspend / Archive / soft-retire document;
-- compliance audit diffs include lifecycle + vehicle linkage fields.
-- Never cascade-delete documents or trip history. Do not apply to production
-- project thazislrdkjpvvghtvzo until authenticated non-prod E2E passes.

BEGIN;

-- 1) Align existing lifecycle Admin RPC authz to page RBAC
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
  v_prev public.vehicles%ROWTYPE;
  v_new public.vehicles%ROWTYPE;
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
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
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
  SELECT * INTO v_prev FROM public.vehicles WHERE id = v_row.vehicle_id FOR UPDATE;
  IF v_row.requested_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_new FROM public.vehicles WHERE id = v_row.requested_vehicle_id FOR UPDATE;
  END IF;

  IF p_decision = 'reject' THEN
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'REJECTION_REASON_REQUIRED');
    END IF;

    UPDATE public.vehicle_change_requests
       SET status = 'rejected', rejection_reason = v_reason, admin_notes = v_notes,
           reviewed_at = now(), reviewed_by = v_uid
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    IF v_new.id IS NOT NULL THEN
      UPDATE public.vehicles
         SET approval_status = 'rejected',
             rejection_reason = v_reason,
             is_trip_active = false,
             operational_status = 'archived',
             updated_at = now()
       WHERE id = v_new.id;
    END IF;

    IF v_row.suspend_previous AND v_prev.id IS NOT NULL THEN
      UPDATE public.vehicles
         SET operational_status = 'active',
             is_trip_active = true,
             suspended_reason = NULL,
             updated_at = now()
       WHERE id = v_prev.id;
    END IF;

    UPDATE public.drivers SET vehicle_edit_request_status = 'rejected' WHERE id = v_row.driver_id;

    INSERT INTO public.driver_inbox_messages (driver_id, type, title, body, metadata)
    VALUES (v_row.driver_id, 'vehicle_change', 'Vehicle change request rejected',
            'Your vehicle change request was not approved. Your previous vehicle records were kept. Reason: ' || v_reason,
            jsonb_build_object('request_id', v_row.id, 'status', 'rejected'));

    INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
    VALUES ('vehicle_change_request_rejected', v_uid, v_row.driver_id,
            jsonb_build_object('request_id', v_row.id, 'reason', v_reason));

    RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
  END IF;

  -- Approve -------------------------------------------------------------------
  IF v_driver.id IS NULL OR v_driver.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_ACTIVE');
  END IF;
  IF v_prev.id IS NULL OR v_prev.driver_id IS DISTINCT FROM v_row.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_MISMATCH');
  END IF;
  IF v_new.id IS NULL OR v_new.driver_id IS DISTINCT FROM v_row.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REQUESTED_VEHICLE_MISSING');
  END IF;
  IF v_prev.make IS DISTINCT FROM v_row.previous_make
     OR v_prev.model IS DISTINCT FROM v_row.previous_model
     OR v_prev.year IS DISTINCT FROM v_row.previous_year
     OR v_prev.color IS DISTINCT FROM v_row.previous_color
     OR v_prev.license_plate IS DISTINCT FROM v_row.previous_license_plate
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_CHANGED_SINCE_REQUEST');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate)
           = public.vehicle_licence_plate_key(v_row.requested_license_plate)
       AND other.id IS DISTINCT FROM v_new.id
       AND other.driver_id IS DISTINCT FROM v_row.driver_id
       AND od.deleted_at IS NULL
       AND other.operational_status <> 'archived'
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

  -- Activate new vehicle; retain previous identity (suspend or demote primary only).
  UPDATE public.vehicles
     SET approval_status = 'approved',
         rejection_reason = NULL,
         is_primary = true,
         is_trip_active = true,
         operational_status = 'active',
         make = v_row.requested_make,
         model = v_row.requested_model,
         year = v_row.requested_year,
         color = v_row.requested_color,
         license_plate = v_row.requested_license_plate,
         updated_at = now()
   WHERE id = v_new.id;

  UPDATE public.vehicles
     SET is_primary = false,
         is_trip_active = false,
         operational_status = CASE
           WHEN v_row.suspend_previous THEN 'suspended_under_repair'
           ELSE operational_status
         END,
         suspended_reason = CASE
           WHEN v_row.suspend_previous THEN COALESCE(v_row.reason, suspended_reason)
           ELSE suspended_reason
         END,
         updated_at = now()
   WHERE id = v_prev.id;

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
          'Your replacement vehicle ' || v_row.requested_make || ' '
            || v_row.requested_model || ' (' || v_row.requested_license_plate
            || ') is now active. Previous vehicle records were kept.',
          jsonb_build_object(
            'request_id', v_row.id,
            'status', 'approved',
            'requested_vehicle_id', v_new.id,
            'previous_vehicle_id', v_prev.id
          ));

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_approved', v_uid, v_row.driver_id,
          jsonb_build_object(
            'request_id', v_row.id,
            'previous_vehicle_id', v_prev.id,
            'requested_vehicle_id', v_new.id,
            'reviewed_document_ids', to_jsonb(v_expected_ids),
            'enabled_vehicle_type_ids', to_jsonb(v_enabled),
            'identity_preserved', true
          ));

  RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
END;
$$;

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
  v_prev public.vehicles%ROWTYPE;
  v_new public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.vehicle_change_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  SELECT * INTO v_prev FROM public.vehicles WHERE id = v_row.vehicle_id;
  IF v_row.requested_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_new FROM public.vehicles WHERE id = v_row.requested_vehicle_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request', public.vehicle_change_request_json(v_row)
      || jsonb_build_object('admin_notes', v_row.admin_notes,
                            'driver_id', v_row.driver_id,
                            'vehicle_id', v_row.vehicle_id,
                            'requested_vehicle_id', v_row.requested_vehicle_id,
                            'reviewed_document_ids', to_jsonb(v_row.reviewed_document_ids),
                            'confirmed_vehicle_type_ids', to_jsonb(v_row.confirmed_vehicle_type_ids)),
    'current_vehicle', CASE WHEN v_prev.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_prev.id,
      'make', v_prev.make,
      'model', v_prev.model,
      'year', v_prev.year,
      'colour', v_prev.color,
      'licence_plate', v_prev.license_plate,
      'approval_status', v_prev.approval_status,
      'operational_status', v_prev.operational_status,
      'is_primary', v_prev.is_primary,
      'is_trip_active', v_prev.is_trip_active,
      'capacity', v_prev.capacity,
      'belongs_to_driver', v_prev.driver_id = v_row.driver_id) END,
    'requested_vehicle', CASE WHEN v_new.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_new.id,
      'make', v_new.make,
      'model', v_new.model,
      'year', v_new.year,
      'colour', v_new.color,
      'licence_plate', v_new.license_plate,
      'approval_status', v_new.approval_status,
      'operational_status', v_new.operational_status,
      'is_primary', v_new.is_primary,
      'is_trip_active', v_new.is_trip_active) END,
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

CREATE OR REPLACE FUNCTION public.admin_return_shared_vehicle_assignment(
  p_assignment_id uuid,
  p_ended_reason text DEFAULT 'returned_to_fleet'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_asg public.vehicle_driver_assignments%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_asg FROM public.vehicle_driver_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_asg.ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_ENDED');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_asg.vehicle_id FOR UPDATE;

  UPDATE public.vehicle_driver_assignments
     SET ended_at = now(),
         ended_reason = NULLIF(btrim(coalesce(p_ended_reason, '')), ''),
         updated_at = now()
   WHERE id = v_asg.id;

  -- Detach from driver saved list; keep asset + documents.
  UPDATE public.vehicles
     SET driver_id = NULL,
         is_primary = false,
         is_trip_active = false,
         operational_status = 'available_in_fleet',
         fleet_shared = true,
         updated_at = now()
   WHERE id = v_vehicle.id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_shared_assignment_returned', v_uid, v_asg.driver_id,
          jsonb_build_object(
            'assignment_id', v_asg.id,
            'vehicle_id', v_vehicle.id,
            'documents_preserved', true
          ));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id, 'assignment_id', v_asg.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reactivate_driver_vehicle(
  p_vehicle_id uuid,
  p_release_temporary_vehicle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_temp public.vehicles%ROWTYPE;
  v_docs jsonb;
  v_doc jsonb;
  v_gaps jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_vehicle.driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_DRIVER');
  END IF;

  -- Temporarily point applicable-docs resolution at this vehicle via a synthetic
  -- check: reuse vehicle_change_applicable_documents only after ensuring target.
  -- Validate current docs on THIS vehicle_id directly.
  FOR v_doc IN
    SELECT jsonb_build_object('slug', s.slug, 'state',
      CASE
        WHEN d.id IS NULL THEN 'missing'
        WHEN lower(COALESCE(d.status,'')) = 'approved'
             AND (d.expiry_date IS NULL OR d.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date)
          THEN 'approved'
        WHEN lower(COALESCE(d.status,'')) = 'pending' THEN 'pending'
        WHEN lower(COALESCE(d.status,'')) = 'rejected' THEN 'rejected'
        WHEN lower(COALESCE(d.status,'')) = 'expired' THEN 'expired'
        WHEN d.expiry_date IS NOT NULL AND d.expiry_date < (now() AT TIME ZONE 'Europe/London')::date THEN 'expired'
        ELSE 'missing'
      END,
      'document_id', d.id
    ) AS j
    FROM unnest(public.vehicle_change_document_slugs()) AS s(slug)
    LEFT JOIN LATERAL (
      SELECT doc.*
        FROM public.documents doc
       WHERE doc.driver_id = v_vehicle.driver_id
         AND doc.document_type = s.slug
         AND COALESCE(doc.is_current, true) = true
         AND doc.vehicle_id = v_vehicle.id
       ORDER BY doc.created_at DESC
       LIMIT 1
    ) d ON true
    WHERE EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          COALESCE(
            (public.get_driver_document_eligibility_internal(v_vehicle.driver_id)->'required_documents'),
            '[]'::jsonb
          )
        ) req WHERE req = s.slug
    )
  LOOP
    IF (v_doc.j->>'state') <> 'approved' THEN
      v_gaps := v_gaps || jsonb_build_array(v_doc.j);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_gaps) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCUMENTS_INVALID', 'gaps', v_gaps);
  END IF;

  -- Clear other trip-active flags for this driver then activate.
  UPDATE public.vehicles
     SET is_trip_active = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM v_vehicle.id
     AND is_trip_active = true;

  UPDATE public.vehicles
     SET operational_status = 'active',
         approval_status = 'approved',
         is_trip_active = true,
         is_primary = true,
         suspended_reason = NULL,
         updated_at = now()
   WHERE id = v_vehicle.id;

  UPDATE public.vehicles
     SET is_primary = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM v_vehicle.id
     AND is_primary = true;

  IF p_release_temporary_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_temp FROM public.vehicles WHERE id = p_release_temporary_vehicle_id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.vehicle_driver_assignments
         SET ended_at = now(),
             ended_reason = 'owner_vehicle_reactivated',
             updated_at = now()
       WHERE vehicle_id = v_temp.id
         AND driver_id = v_vehicle.driver_id
         AND ended_at IS NULL;

      UPDATE public.vehicles
         SET driver_id = CASE WHEN fleet_shared THEN NULL ELSE driver_id END,
             is_primary = false,
             is_trip_active = false,
             operational_status = CASE WHEN fleet_shared THEN 'available_in_fleet' ELSE operational_status END,
             updated_at = now()
       WHERE id = v_temp.id;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_reactivated', v_uid, v_vehicle.driver_id,
          jsonb_build_object(
            'vehicle_id', v_vehicle.id,
            'released_temporary_vehicle_id', p_release_temporary_vehicle_id,
            'reused_documents', true
          ));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_assign_shared_vehicle(
  p_vehicle_id uuid,
  p_driver_id uuid,
  p_suspend_previous boolean DEFAULT true,
  p_reason text DEFAULT 'Temporary shared replacement'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_prev public.vehicles%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_asg_id uuid;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id FOR UPDATE;
  IF NOT FOUND OR v_driver.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_FOUND');
  END IF;
  IF v_vehicle.operational_status <> 'available_in_fleet' AND NOT (
    v_vehicle.fleet_shared AND v_vehicle.driver_id IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AVAILABLE_IN_FLEET');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vehicle_driver_assignments a
     WHERE a.vehicle_id = p_vehicle_id AND a.ended_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_ASSIGNED');
  END IF;

  SELECT * INTO v_prev
    FROM public.vehicles v
   WHERE v.driver_id = p_driver_id
     AND v.is_trip_active = true
   ORDER BY v.updated_at DESC
   LIMIT 1
   FOR UPDATE;

  UPDATE public.vehicles
     SET driver_id = p_driver_id,
         fleet_shared = true,
         operational_status = 'active',
         approval_status = 'approved',
         is_trip_active = true,
         is_primary = false,
         updated_at = now()
   WHERE id = p_vehicle_id;

  IF FOUND AND COALESCE(p_suspend_previous, true) AND v_prev.id IS NOT NULL THEN
    UPDATE public.vehicles
       SET is_trip_active = false,
           operational_status = 'suspended_under_repair',
           suspended_reason = COALESCE(v_reason, 'Temporary shared replacement'),
           updated_at = now()
     WHERE id = v_prev.id;
  ELSIF v_prev.id IS NOT NULL THEN
    UPDATE public.vehicles
       SET is_trip_active = false,
           updated_at = now()
     WHERE id = v_prev.id;
  END IF;

  INSERT INTO public.vehicle_driver_assignments (
    vehicle_id, driver_id, assignment_kind, started_at
  ) VALUES (
    p_vehicle_id, p_driver_id, 'temporary_replacement', now()
  )
  RETURNING id INTO v_asg_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_shared_assignment_started', v_uid, p_driver_id,
          jsonb_build_object(
            'assignment_id', v_asg_id,
            'vehicle_id', p_vehicle_id,
            'previous_vehicle_id', v_prev.id,
            'suspend_previous', COALESCE(p_suspend_previous, true)
          ));

  RETURN jsonb_build_object(
    'ok', true,
    'assignment_id', v_asg_id,
    'vehicle_id', p_vehicle_id,
    'driver_id', p_driver_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_list_open_vehicle_assignments(
  p_driver_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object('ok', true, 'assignments', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', a.id,
      'vehicle_id', a.vehicle_id,
      'driver_id', a.driver_id,
      'assignment_kind', a.assignment_kind,
      'started_at', a.started_at,
      'licence_plate', v.license_plate,
      'make', v.make,
      'model', v.model,
      'year', v.year,
      'driver_first_name', d.first_name,
      'driver_last_name', d.last_name
    ) ORDER BY a.started_at DESC)
      FROM public.vehicle_driver_assignments a
      JOIN public.vehicles v ON v.id = a.vehicle_id
      JOIN public.drivers d ON d.id = a.driver_id
     WHERE a.ended_at IS NULL
       AND (p_driver_id IS NULL OR a.driver_id = p_driver_id)
  ), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_resolve_document_vehicle_link(
  p_document_id uuid,
  p_vehicle_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_doc public.documents%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','documents','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_doc FROM public.documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF NOT public.is_vehicle_scoped_document_slug(v_doc.document_type) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_VEHICLE_SCOPED');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_FOUND');
  END IF;
  IF v_vehicle.driver_id IS DISTINCT FROM v_doc.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_MISMATCH');
  END IF;

  UPDATE public.documents
     SET vehicle_id = p_vehicle_id,
         ambiguity_review_required = false,
         updated_at = now()
   WHERE id = p_document_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('document_vehicle_link_resolved', v_uid, v_doc.driver_id,
          jsonb_build_object(
            'document_id', p_document_id,
            'vehicle_id', p_vehicle_id,
            'document_type', v_doc.document_type
          ));

  RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'vehicle_id', p_vehicle_id);
END;
$$;

-- 2) New Admin controls

CREATE OR REPLACE FUNCTION public.admin_set_trip_active_vehicle(
  p_vehicle_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_before jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_FOUND');
  END IF;
  IF v_vehicle.driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_DRIVER');
  END IF;
  IF v_vehicle.operational_status = 'archived' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ARCHIVED');
  END IF;
  IF v_vehicle.approval_status <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_APPROVED');
  END IF;
  IF v_vehicle.operational_status = 'suspended_under_repair' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SUSPENDED');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  END IF;

  v_before := jsonb_build_object(
    'vehicle_id', v_vehicle.id,
    'is_trip_active', v_vehicle.is_trip_active,
    'operational_status', v_vehicle.operational_status
  );

  UPDATE public.vehicles
     SET is_trip_active = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM p_vehicle_id
     AND is_trip_active = true;

  UPDATE public.vehicles
     SET is_trip_active = true,
         operational_status = 'active',
         updated_at = now()
   WHERE id = p_vehicle_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES (
    'vehicle_set_trip_active',
    v_uid,
    v_vehicle.driver_id,
    jsonb_build_object(
      'reason', v_reason,
      'before', v_before,
      'after', jsonb_build_object('is_trip_active', true, 'operational_status', 'active'),
      'documents_preserved', true
    )
      || jsonb_build_object('entity_id', p_vehicle_id)
  );

  RETURN jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id, 'documents_preserved', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_trip_active_vehicle(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_trip_active_vehicle(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_suspend_driver_vehicle(
  p_vehicle_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_before jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_FOUND');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  END IF;
  IF v_vehicle.operational_status = 'archived' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ARCHIVED');
  END IF;

  v_before := jsonb_build_object(
    'operational_status', v_vehicle.operational_status,
    'is_trip_active', v_vehicle.is_trip_active,
    'suspended_reason', v_vehicle.suspended_reason
  );

  UPDATE public.vehicles
     SET operational_status = 'suspended_under_repair',
         is_trip_active = false,
         suspended_reason = v_reason,
         updated_at = now()
   WHERE id = p_vehicle_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES (
    'vehicle_suspended',
    v_uid,
    v_vehicle.driver_id,
    jsonb_build_object(
      'reason', v_reason,
      'before', v_before,
      'after', jsonb_build_object(
        'operational_status', 'suspended_under_repair',
        'is_trip_active', false,
        'suspended_reason', v_reason
      ),
      'documents_preserved', true
    )
      || jsonb_build_object('entity_id', p_vehicle_id)
  );

  RETURN jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id, 'documents_preserved', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_suspend_driver_vehicle(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_suspend_driver_vehicle(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_archive_driver_vehicle(
  p_vehicle_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_open uuid;
  v_before jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_FOUND');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  END IF;
  IF v_vehicle.operational_status = 'archived' THEN
    RETURN jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id, 'already_archived', true,
      'status_label', 'Archived — removed from active use; history retained');
  END IF;
  IF v_vehicle.is_trip_active THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_IN_USE');
  END IF;
  IF v_vehicle.is_primary THEN
    RETURN jsonb_build_object('ok', false, 'code', 'IS_PRIMARY');
  END IF;

  SELECT a.id INTO v_open
    FROM public.vehicle_driver_assignments a
   WHERE a.vehicle_id = p_vehicle_id AND a.ended_at IS NULL
   LIMIT 1;
  IF v_open IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'OPEN_ASSIGNMENT');
  END IF;

  v_before := jsonb_build_object(
    'operational_status', v_vehicle.operational_status,
    'is_trip_active', v_vehicle.is_trip_active,
    'is_primary', v_vehicle.is_primary,
    'driver_id', v_vehicle.driver_id
  );

  UPDATE public.vehicles
     SET operational_status = 'archived',
         is_trip_active = false,
         is_primary = false,
         suspended_reason = coalesce(v_vehicle.suspended_reason, v_reason),
         updated_at = now()
   WHERE id = p_vehicle_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES (
    'vehicle_archived',
    v_uid,
    v_vehicle.driver_id,
    jsonb_build_object(
      'reason', v_reason,
      'before', v_before,
      'after', jsonb_build_object('operational_status', 'archived', 'is_trip_active', false),
      'documents_preserved', true,
      'status_label', 'Archived — removed from active use; history retained'
    )
      || jsonb_build_object('entity_id', p_vehicle_id)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'vehicle_id', p_vehicle_id,
    'documents_preserved', true,
    'status', 'archived',
    'status_label', 'Archived — removed from active use; history retained'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_archive_driver_vehicle(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_archive_driver_vehicle(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_retire_document(
  p_document_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_doc public.documents%ROWTYPE;
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_before jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['documents', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_doc FROM public.documents WHERE id = p_document_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  END IF;
  IF coalesce(v_doc.is_current, true) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', true, 'document_id', p_document_id, 'already_retired', true,
      'status_label', 'Retired — removed from active use; prior file retained in history');
  END IF;

  v_before := jsonb_build_object(
    'is_current', v_doc.is_current,
    'status', v_doc.status,
    'vehicle_id', v_doc.vehicle_id
  );

  UPDATE public.documents
     SET is_current = false,
         notes = CASE
           WHEN NULLIF(btrim(coalesce(notes, '')), '') IS NULL THEN 'Admin retired: ' || v_reason
           ELSE notes || E'\nAdmin retired: ' || v_reason
         END,
         updated_at = now()
   WHERE id = p_document_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES (
    'document_retired',
    v_uid,
    v_doc.driver_id,
    jsonb_build_object(
      'reason', v_reason,
      'before', v_before,
      'after', jsonb_build_object('is_current', false),
      'status_label', 'Retired — removed from active use; prior file retained in history',
      'vehicle_id_unchanged', v_doc.vehicle_id
    )
      || jsonb_build_object('entity_id', p_document_id)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'document_id', p_document_id,
    'is_current', false,
    'status_label', 'Retired — removed from active use; prior file retained in history'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_retire_document(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_retire_document(uuid, text) TO authenticated, service_role;


-- 3) Compliance audit field coverage
CREATE OR REPLACE FUNCTION public.trg_documents_compliance_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.documents%ROWTYPE;
  v_changes jsonb;
  v_action text;
  v_uid uuid;
  v_actor jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  v_changes := public.driver_compliance_audit_diff(
    CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END,
    ARRAY['status','expiry_date','rejection_reason','notes','document_type','document_name','is_current','vehicle_id','ambiguity_review_required']);

  IF TG_OP = 'UPDATE' AND OLD.file_url IS DISTINCT FROM NEW.file_url THEN
    v_changes := v_changes || jsonb_build_object('file', jsonb_build_object('from', 'previous file', 'to', 'new file'));
  END IF;

  IF TG_OP = 'UPDATE' AND v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'uploaded';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    v_action := CASE NEW.status
      WHEN 'approved' THEN 'approved'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'pending' THEN 'set_pending'
      WHEN 'expired' THEN 'expired'
      ELSE 'status_changed' END;
  ELSIF NEW.status = 'rejected' AND OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason THEN
    v_action := 're_rejected';
  ELSIF OLD.is_current IS DISTINCT FROM NEW.is_current AND NEW.is_current = false THEN
    v_action := 'superseded';
  ELSIF OLD.expiry_date IS DISTINCT FROM NEW.expiry_date THEN
    v_action := 'expiry_changed';
  ELSE
    v_action := 'updated';
  END IF;

  v_uid := COALESCE(
    auth.uid(),
    CASE WHEN TG_OP = 'UPDATE' AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason) THEN NEW.reviewed_by END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.uploaded_by END);
  v_actor := public.driver_compliance_audit_actor(v_uid);

  INSERT INTO public.driver_compliance_audit_log
    (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name)
  VALUES
    (v_row.driver_id, 'document', v_row.id,
     COALESCE(NULLIF(btrim(v_row.document_name), ''), v_row.document_type),
     v_action, v_changes, v_uid, v_actor->>'kind', v_actor->>'name');
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_vehicles_compliance_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.vehicles%ROWTYPE;
  v_changes jsonb;
  v_action text;
  v_uid uuid := auth.uid();
  v_actor jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  v_changes := public.driver_compliance_audit_diff(
    CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END,
    ARRAY['make','model','year','color','license_plate','is_primary','approval_status','rejection_reason','capacity','vehicle_type_id','driver_id','operational_status','is_trip_active','fleet_shared','suspended_reason']);

  IF TG_OP = 'UPDATE' AND v_changes = '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'added';
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
  ELSIF OLD.approval_status IS DISTINCT FROM NEW.approval_status THEN
    v_action := CASE NEW.approval_status
      WHEN 'approved' THEN 'approved'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'pending' THEN 'set_pending'
      ELSE 'status_changed' END;
  ELSIF NEW.approval_status = 'rejected' AND OLD.rejection_reason IS DISTINCT FROM NEW.rejection_reason THEN
    v_action := 're_rejected';
  ELSIF OLD.driver_id IS DISTINCT FROM NEW.driver_id AND NEW.driver_id IS NULL THEN
    v_action := 'unassigned';
  ELSIF OLD.operational_status IS DISTINCT FROM NEW.operational_status THEN
    v_action := CASE NEW.operational_status
      WHEN 'suspended_under_repair' THEN 'suspended'
      WHEN 'archived' THEN 'archived'
      WHEN 'active' THEN 'reactivated'
      WHEN 'available_in_fleet' THEN 'returned_to_fleet'
      ELSE 'status_changed' END;
  ELSIF OLD.is_trip_active IS DISTINCT FROM NEW.is_trip_active AND NEW.is_trip_active THEN
    v_action := 'set_trip_active';
  ELSE
    v_action := 'updated';
  END IF;

  v_actor := public.driver_compliance_audit_actor(v_uid);

  INSERT INTO public.driver_compliance_audit_log
    (driver_id, entity_type, entity_id, entity_label, action, changes, actor_user_id, actor_kind, actor_name)
  VALUES
    (COALESCE(v_row.driver_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.driver_id END),
     'vehicle', v_row.id,
     btrim(concat_ws(' ', v_row.year::text, v_row.make, v_row.model, '·', v_row.license_plate)),
     v_action, v_changes, v_uid, v_actor->>'kind', v_actor->>'name');
  RETURN NULL;
END;
$$;

COMMIT;
