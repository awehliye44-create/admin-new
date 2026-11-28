-- Vehicle lifecycle UI wiring + document upload ownership hardening.
-- Completes agreed workflow steps that were previously RPC-only.
-- No deploy in this change set — migration authored for Owner-gated apply.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. My Documents SSOT: vehicle docs scoped to TRIP-ACTIVE vehicle only.
--    Pending replacement uploads use resolve_vehicle_document_target via stamp
--    + get_my_vehicle_change_applicable_documents (separate section).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.driver_document_compliance_ssot AS
 WITH targets AS (
         SELECT dr.id AS driver_id,
            public.resolve_trip_active_vehicle_id(dr.id) AS vehicle_id
           FROM drivers dr
        ), current_docs AS (
         SELECT d.driver_id,
            d.document_type,
            d.id AS document_id,
            d.status,
            d.expiry_date,
            d.file_url,
            d.updated_at,
            d.is_current,
            d.superseded_by,
            d.vehicle_id
           FROM documents d
           JOIN targets t ON t.driver_id = d.driver_id
          WHERE d.is_current = true
            AND (
              NOT public.is_vehicle_scoped_document_slug(d.document_type)
              OR d.vehicle_id IS NOT DISTINCT FROM t.vehicle_id
            )
        ), today_london AS (
         SELECT (now() AT TIME ZONE 'Europe/London'::text)::date AS today
        )
 SELECT dr.id AS driver_id,
    dt.id AS document_type_id,
    dt.slug AS document_type_key,
    dt.name AS display_name,
    dt.is_required,
    dt.has_expiry,
    cd.document_id,
    cd.status AS approval_status,
    cd.expiry_date,
    cd.file_url,
    cd.updated_at AS last_updated_at,
    cd.superseded_by AS replacement_document_id,
    COALESCE(cd.is_current, false) AS is_current,
    cd.document_id IS NOT NULL AND cd.is_current = false AS is_superseded,
    document_type_renewal_open_days(dt.reminder_days_before_expiry) AS renewal_open_days,
        CASE
            WHEN cd.expiry_date IS NULL THEN NULL::integer
            ELSE cd.expiry_date - (( SELECT today_london.today FROM today_london))
        END AS days_until_expiry,
        CASE
            WHEN cd.document_id IS NULL THEN 'missing'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text]) THEN 'rejected'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['pending'::text, 'uploaded'::text, 'submitted'::text, 'under_review'::text]) THEN 'pending'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)) THEN 'expired'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND lower(COALESCE(cd.status, ''::text)) = 'approved'::text AND cd.expiry_date <= ((( SELECT today_london.today FROM today_london)) + make_interval(days => document_type_renewal_open_days(dt.reminder_days_before_expiry)))::date THEN 'expiring_soon'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = 'approved'::text THEN 'approved_valid'::text
            ELSE 'pending'::text
        END AS expiry_status,
        CASE
            WHEN cd.document_id IS NULL THEN 'missing'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text]) THEN 'rejected'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['pending'::text, 'uploaded'::text, 'submitted'::text, 'under_review'::text]) THEN 'pending_review'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)) THEN 'expired'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND lower(COALESCE(cd.status, ''::text)) = 'approved'::text AND cd.expiry_date <= ((( SELECT today_london.today FROM today_london)) + make_interval(days => document_type_renewal_open_days(dt.reminder_days_before_expiry)))::date THEN 'expiring'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = 'approved'::text THEN 'valid'::text
            ELSE 'pending_review'::text
        END AS renewal_state,
        CASE
            WHEN cd.document_id IS NULL THEN true
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text]) THEN true
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['pending'::text, 'uploaded'::text, 'submitted'::text, 'under_review'::text]) THEN false
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)) THEN true
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND lower(COALESCE(cd.status, ''::text)) = 'approved'::text AND (cd.expiry_date - (( SELECT today_london.today FROM today_london))) <= document_type_renewal_open_days(dt.reminder_days_before_expiry) THEN true
            ELSE false
        END AS can_upload_replacement,
    dt.is_required AND (cd.document_id IS NULL OR (lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text])) OR dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london))) AS blocks_online
   FROM drivers dr
     CROSS JOIN document_types dt
     LEFT JOIN current_docs cd ON cd.driver_id = dr.id AND cd.document_type = dt.slug
  WHERE dt.is_active = true AND (dt.is_required = true OR cd.document_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2. Stamp trigger: validate ownership; never attach another driver's vehicle
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assert_document_vehicle_ownership(
  p_driver_id uuid,
  p_vehicle_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  IF p_vehicle_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.vehicles v
     WHERE v.id = p_vehicle_id
       AND v.driver_id IS NOT DISTINCT FROM p_driver_id
  ) THEN
    RAISE EXCEPTION 'DOCUMENT_VEHICLE_OWNERSHIP_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_documents_stamp_vehicle_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_target uuid;
BEGIN
  IF NOT public.is_vehicle_scoped_document_slug(NEW.document_type) THEN
    -- Driver-scoped docs must not inherit a vehicle id.
    NEW.vehicle_id := NULL;
    RETURN NEW;
  END IF;

  v_target := public.resolve_vehicle_document_target(NEW.driver_id);

  IF NEW.vehicle_id IS NULL THEN
    NEW.vehicle_id := v_target;
  ELSE
    -- Caller-supplied vehicle_id must belong to this driver.
    PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
    -- During a pending replacement, force uploads onto the requested vehicle
    -- when the supplied id is not that target (prevents writing onto old primary).
    IF v_target IS NOT NULL AND NEW.vehicle_id IS DISTINCT FROM v_target THEN
      IF EXISTS (
        SELECT 1 FROM public.vehicle_change_requests r
         WHERE r.driver_id = NEW.driver_id
           AND r.status = 'pending'
           AND r.requested_vehicle_id = v_target
      ) THEN
        NEW.vehicle_id := v_target;
      END IF;
    END IF;
  END IF;

  PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Driver: list saved vehicles (Primary / remove UI)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_driver_saved_vehicles()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT d.id INTO v_driver_id FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'vehicles', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('ok', true, 'vehicles', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', v.id,
      'make', v.make,
      'model', v.model,
      'year', v.year,
      'colour', v.color,
      'licence_plate', v.license_plate,
      'approval_status', v.approval_status,
      'is_primary', COALESCE(v.is_primary, false),
      'is_trip_active', COALESCE(v.is_trip_active, false),
      'operational_status', v.operational_status,
      'fleet_shared', COALESCE(v.fleet_shared, false),
      'can_set_primary',
        COALESCE(v.operational_status, 'active') NOT IN ('available_in_fleet', 'archived')
        AND COALESCE(v.is_primary, false) = false,
      'can_remove',
        COALESCE(v.is_trip_active, false) = false
        AND COALESCE(v.is_primary, false) = false
        AND COALESCE(v.fleet_shared, false) = false
        AND COALESCE(v.operational_status, 'active') NOT IN ('available_in_fleet', 'archived')
        AND NOT EXISTS (
          SELECT 1 FROM public.vehicle_change_requests r
           WHERE r.driver_id = v_driver_id AND r.status = 'pending'
             AND (r.vehicle_id = v.id OR r.requested_vehicle_id = v.id)
        )
    ) ORDER BY v.is_trip_active DESC, v.is_primary DESC, v.created_at ASC)
      FROM public.vehicles v
     WHERE v.driver_id = v_driver_id
       AND COALESCE(v.operational_status, 'active') NOT IN ('available_in_fleet', 'archived')
  ), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.list_driver_saved_vehicles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_driver_saved_vehicles() TO authenticated, service_role;

-- Driver-facing wrapper for replacement document requirements (own driver only).
CREATE OR REPLACE FUNCTION public.get_my_vehicle_change_applicable_documents()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_pending public.vehicle_change_requests%ROWTYPE;
  v_docs jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT d.id INTO v_driver_id FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  SELECT * INTO v_pending
    FROM public.vehicle_change_requests
   WHERE driver_id = v_driver_id AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'pending', false,
      'documents', '[]'::jsonb,
      'vehicle_id', NULL
    );
  END IF;

  v_docs := public.vehicle_change_applicable_documents(v_driver_id);
  RETURN jsonb_build_object(
    'ok', true,
    'pending', true,
    'request_id', v_pending.id,
    'requested_vehicle_id', v_pending.requested_vehicle_id,
    'requested_licence_plate', v_pending.requested_license_plate,
    'rules_available', COALESCE((v_docs->>'rules_available')::boolean, false),
    'vehicle_id', v_docs->>'vehicle_id',
    'documents', COALESCE(v_docs->'documents', '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_vehicle_change_applicable_documents() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_vehicle_change_applicable_documents() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Admin: assign shared fleet vehicle to a driver (time-bounded)
-- ---------------------------------------------------------------------------

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
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
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

REVOKE ALL ON FUNCTION public.admin_assign_shared_vehicle(uuid, uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_shared_vehicle(uuid, uuid, boolean, text) TO authenticated, service_role;

-- List open assignments for Admin Vehicles / Driver Details.
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
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
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

REVOKE ALL ON FUNCTION public.admin_list_open_vehicle_assignments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_open_vehicle_assignments(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Admin: resolve ambiguous document ↔ vehicle links
-- ---------------------------------------------------------------------------

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
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
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

REVOKE ALL ON FUNCTION public.admin_resolve_document_vehicle_link(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_document_vehicle_link(uuid, uuid) TO authenticated, service_role;

-- Allow documents page to filter ambiguity rows.
-- (_admin_page_columns already includes ambiguity_review_required from prior migration.)


-- Include document_type_id + replacement-only sides_on_file for Driver dual-side recovery.
-- sides_on_file is scoped to the pending replacement vehicle document — never the Active vehicle.
CREATE OR REPLACE FUNCTION public.vehicle_change_applicable_documents(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_elig jsonb;
  v_docs jsonb := '[]'::jsonb;
  v_slug text;
  v_state text;
  v_doc record;
  v_target uuid;
  v_type_id uuid;
  v_type_name text;
  v_sides text[] := ARRAY[]::text[];
  v_has_front boolean;
  v_has_back boolean;
BEGIN
  v_elig := public.get_driver_document_eligibility_internal(p_driver_id);
  v_target := public.resolve_vehicle_document_target(p_driver_id);

  IF v_elig IS NULL
     OR v_elig->>'code' IN ('DRIVER_SERVICE_AREA_NOT_ASSIGNED', 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED')
  THEN
    RETURN jsonb_build_object(
      'rules_available', false,
      'code', COALESCE(v_elig->>'code', 'DOCUMENT_ELIGIBILITY_UNAVAILABLE'),
      'vehicle_id', v_target,
      'documents', '[]'::jsonb
    );
  END IF;

  FOR v_slug IN
    SELECT s FROM unnest(public.vehicle_change_document_slugs()) AS s
    WHERE COALESCE(v_elig->'required_documents', '[]'::jsonb) ? s
  LOOP
    SELECT dt.id, dt.name INTO v_type_id, v_type_name
      FROM public.document_types dt WHERE dt.slug = v_slug LIMIT 1;

    SELECT d.id, d.status, d.expiry_date, d.file_url, d.reviewed_at, d.created_at,
           COALESCE(dt.name, d.document_name, v_slug) AS name,
           d.vehicle_id
      INTO v_doc
      FROM public.documents d
      LEFT JOIN public.document_types dt ON dt.slug = d.document_type
     WHERE d.driver_id = p_driver_id
       AND d.document_type = v_slug
       AND COALESCE(d.is_current, true) = true
       AND (v_target IS NULL OR d.vehicle_id IS NOT DISTINCT FROM v_target)
     ORDER BY d.created_at DESC
     LIMIT 1;

    v_sides := ARRAY[]::text[];
    IF v_doc.id IS NOT NULL THEN
      SELECT coalesce(
               array_agg(DISTINCT da.side ORDER BY da.side),
               ARRAY[]::text[]
             )
        INTO v_sides
        FROM public.document_attachments da
       WHERE da.document_id = v_doc.id
         AND coalesce(da.is_current, true) = true
         AND da.side IN ('front', 'back');
    END IF;
    v_has_front := 'front' = ANY (coalesce(v_sides, ARRAY[]::text[]));
    v_has_back := 'back' = ANY (coalesce(v_sides, ARRAY[]::text[]));

    v_state := CASE
      WHEN v_doc.id IS NULL THEN 'missing'
      WHEN lower(COALESCE(v_doc.status, '')) = 'approved' THEN 'approved'
      WHEN lower(COALESCE(v_doc.status, '')) = 'pending' THEN 'pending'
      WHEN lower(COALESCE(v_doc.status, '')) = 'rejected' THEN 'rejected'
      WHEN lower(COALESCE(v_doc.status, '')) = 'expired' THEN 'expired'
      ELSE 'missing'
    END;

    v_docs := v_docs || jsonb_build_array(jsonb_build_object(
      'slug', v_slug,
      'document_type_id', v_type_id,
      'name', COALESCE(v_doc.name, v_type_name, v_slug),
      'state', v_state,
      'document_id', v_doc.id,
      'document_status', v_doc.status,
      'expiry_date', v_doc.expiry_date,
      'file_url', v_doc.file_url,
      'reviewed_at', v_doc.reviewed_at,
      'uploaded_at', v_doc.created_at,
      'vehicle_id', COALESCE(v_doc.vehicle_id, v_target),
      'sides_on_file', to_jsonb(coalesce(v_sides, ARRAY[]::text[])),
      'expiring_soon', COALESCE(v_elig->'expiring_soon_documents', '[]'::jsonb) ? v_slug,
      'action_label', CASE
        WHEN v_state = 'approved' THEN 'Approved'
        WHEN v_state = 'pending' AND v_has_front AND NOT v_has_back THEN 'Back required'
        WHEN v_state = 'pending' AND v_has_back AND NOT v_has_front THEN 'Front required'
        WHEN v_state = 'pending' THEN 'In Review'
        ELSE 'Action required'
      END
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'rules_available', true,
    'code', NULL,
    'vehicle_id', v_target,
    'documents', v_docs
  );
END;
$$;

COMMIT;
