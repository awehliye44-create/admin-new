-- Admin: archive a non-active vehicle from the driver list, and attach a
-- manual document to the vehicle Admin confirmed.
-- Does not depend on 20270305240000–20270305270000.
-- Does not delete documents, vehicles, or audit history.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Remove vehicle = archive. Active trip vehicle stays until another is active.
--    A leftover Primary flag can be cleared once another vehicle is trip-active.
-- ---------------------------------------------------------------------------

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
  IF COALESCE(v_vehicle.is_primary, false)
     AND NOT EXISTS (
       SELECT 1 FROM public.vehicles other
        WHERE other.driver_id = v_vehicle.driver_id
          AND other.id IS DISTINCT FROM p_vehicle_id
          AND other.is_trip_active = true
          AND COALESCE(other.operational_status, 'active') IS DISTINCT FROM 'archived'
     )
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_IN_USE');
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

  IF COALESCE(v_vehicle.is_primary, false) THEN
    UPDATE public.vehicles
       SET is_primary = true,
           updated_at = now()
     WHERE driver_id = v_vehicle.driver_id
       AND id IS DISTINCT FROM p_vehicle_id
       AND is_trip_active = true
       AND COALESCE(operational_status, 'active') IS DISTINCT FROM 'archived';
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES (
    'vehicle_archived',
    v_uid,
    v_vehicle.driver_id,
    jsonb_build_object(
      'reason', v_reason,
      'before', v_before,
      'after', jsonb_build_object('operational_status', 'archived', 'is_trip_active', false, 'is_primary', false),
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

-- ---------------------------------------------------------------------------
-- 2. Stamp keeps driver inserts on the established target.
--    Admin submit may name one owned, non-archived vehicle via a transaction GUC.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_documents_stamp_vehicle_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_target uuid;
  v_admin text := NULLIF(current_setting('onecab.admin_document_vehicle_id', true), '');
BEGIN
  IF NOT public.is_vehicle_scoped_document_slug(NEW.document_type) THEN
    NEW.vehicle_id := NULL;
    RETURN NEW;
  END IF;

  IF v_admin IS NOT NULL THEN
    BEGIN
      v_target := v_admin::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_target := NULL;
    END;
    IF v_target IS NOT NULL THEN
      NEW.vehicle_id := v_target;
      NEW.ambiguity_review_required := false;
      PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
      RETURN NEW;
    END IF;
  END IF;

  v_target := public.resolve_vehicle_document_target(NEW.driver_id);

  IF v_target IS NULL THEN
    NEW.vehicle_id := NULL;
    NEW.ambiguity_review_required := true;
    RETURN NEW;
  END IF;

  NEW.vehicle_id := v_target;
  NEW.ambiguity_review_required := false;
  PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_documents_stamp_vehicle_id() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Admin upload: explicit vehicle for vehicle-scoped documents.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid);

CREATE OR REPLACE FUNCTION public.admin_submit_driver_document(
  p_driver_id uuid,
  p_document_type_id uuid,
  p_storage_path text,
  p_side text DEFAULT 'front',
  p_expiry_date date DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_original_filename text DEFAULT NULL,
  p_file_size_bytes bigint DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL,
  p_vehicle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_staff public.staff_profiles%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_dtype public.document_types%ROWTYPE;
  v_side text := lower(btrim(coalesce(p_side, 'front')));
  v_path text := btrim(coalesce(p_storage_path, ''));
  v_doc public.documents%ROWTYPE;
  v_att_id uuid;
  v_existing_att uuid;
  v_existing_doc_id uuid;
  v_reuse_pending boolean := false;
  v_can_replace boolean;
  v_expiry_status text;
  v_approval text;
  v_sa_expiry_required boolean;
  v_now timestamptz := now();
  v_target_status text;
  v_target_expiry date;
  v_trip_vehicle uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHENTICATED', 'message', 'Authentication required');
  END IF;

  IF NOT public.staff_has_action(v_uid, 'documents.admin_upload') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'FORBIDDEN',
      'message', 'documents.admin_upload permission required'
    );
  END IF;

  SELECT * INTO v_staff
  FROM public.staff_profiles
  WHERE user_id = v_uid AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Active staff profile required');
  END IF;

  IF p_driver_id IS NULL OR p_document_type_id IS NULL OR v_path = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ARGS', 'message', 'driver, document type and storage path are required');
  END IF;

  -- Legacy Admin client used 'single'; Driver / CHECK SSOT uses 'full'.
  IF v_side = 'single' THEN
    v_side := 'full';
  END IF;

  IF v_side NOT IN ('front', 'back', 'full', 'other') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_SIDE', 'message', 'side must be front, back, full, or other');
  END IF;

  -- Prevent path traversal / cross-driver uploads.
  IF v_path ~ '\.\.' OR position('/' in v_path) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_STORAGE_PATH', 'message', 'Invalid storage path');
  END IF;
  IF split_part(v_path, '/', 1) IS DISTINCT FROM p_driver_id::text THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'STORAGE_OWNERSHIP',
      'message', 'Storage path must be under the target driver id'
    );
  END IF;

  -- Object must already exist in the private bucket (upload happens via storage policies first).
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'driver-documents'
      AND o.name = v_path
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'STORAGE_MISSING',
      'message', 'File not found in driver-documents storage'
    );
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND OR v_driver.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_NOT_FOUND', 'message', 'Driver not found');
  END IF;

  IF NOT public.driver_has_completed_registration_verification(p_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_NOT_ELIGIBLE',
      'message', 'Driver must complete email verification, phone verification and Terms acceptance before Admin upload'
    );
  END IF;

  SELECT * INTO v_dtype
  FROM public.document_types
  WHERE id = p_document_type_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'DOCUMENT_TYPE_NOT_FOUND', 'message', 'Document type not found or inactive');
  END IF;

  -- Service-area expiry requirement when driver has an assigned SA rule.
  SELECT coalesce(bool_or(r.expiry_required), v_dtype.has_expiry)
    INTO v_sa_expiry_required
  FROM public.driver_service_areas dsa
  JOIN public.service_area_document_rules r
    ON r.service_area_id = dsa.service_area_id
   AND r.doc_type_id = v_dtype.id
   AND r.is_active = true
  WHERE dsa.driver_id = p_driver_id;

  v_sa_expiry_required := coalesce(v_sa_expiry_required, v_dtype.has_expiry);

  IF v_sa_expiry_required AND p_expiry_date IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'EXPIRY_REQUIRED', 'message', 'Expiry date is required for this document type');
  END IF;

  -- Idempotency on attachment key (same as driver submit contract intent).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT da.id, da.document_id
      INTO v_existing_att, v_existing_doc_id
    FROM public.document_attachments da
    WHERE da.submission_idempotency_key = p_idempotency_key
    LIMIT 1;
    IF FOUND THEN
      SELECT * INTO v_doc FROM public.documents WHERE id = v_existing_doc_id;
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'document_id', v_doc.id,
        'attachment_id', v_existing_att,
        'status', v_doc.status
      );
    END IF;
  END IF;

  -- Explicit vehicle id: the new Admin confirmed that registration.
  -- Omitted vehicle id: the current Admin client. Keep the previous compliance
  -- gate and stamp target so those uploads still succeed during cutover.
  -- Driver-scoped documents ignore p_vehicle_id. The stamp clears their vehicle_id.
  IF public.is_vehicle_scoped_document_slug(v_dtype.slug) AND p_vehicle_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.vehicles v
       WHERE v.id = p_vehicle_id
         AND v.driver_id = p_driver_id
         AND COALESCE(v.operational_status, 'active') IS DISTINCT FROM 'archived'
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'VEHICLE_NOT_SELECTABLE',
        'message', 'That vehicle cannot receive documents'
      );
    END IF;

    v_trip_vehicle := public.resolve_trip_active_vehicle_id(p_driver_id);
    IF p_vehicle_id IS NOT DISTINCT FROM v_trip_vehicle THEN
      SELECT c.can_upload_replacement, c.expiry_status, c.approval_status
        INTO v_can_replace, v_expiry_status, v_approval
      FROM public.driver_document_compliance_ssot c
      WHERE c.driver_id = p_driver_id
        AND c.document_type_id = p_document_type_id
      LIMIT 1;
      IF v_approval = 'approved'
         AND v_expiry_status IN ('approved_valid', 'expiring_soon')
         AND coalesce(v_can_replace, false) IS NOT TRUE THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'REPLACEMENT_NOT_ALLOWED',
          'message', 'An approved document is still valid; replacement is not open yet'
        );
      END IF;
    ELSE
      SELECT lower(coalesce(d.status, '')), d.expiry_date
        INTO v_target_status, v_target_expiry
      FROM public.documents d
      WHERE d.driver_id = p_driver_id
        AND d.document_type_id = p_document_type_id
        AND d.vehicle_id = p_vehicle_id
        AND COALESCE(d.is_current, false) = true
      ORDER BY d.created_at DESC
      LIMIT 1;
      IF v_target_status = 'approved'
         AND (v_target_expiry IS NULL OR v_target_expiry >= (now() AT TIME ZONE 'Europe/London')::date) THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'REPLACEMENT_NOT_ALLOWED',
          'message', 'This vehicle already has an approved document that is still valid'
        );
      END IF;
    END IF;
    PERFORM set_config('onecab.admin_document_vehicle_id', p_vehicle_id::text, true);
  ELSE
    SELECT c.can_upload_replacement, c.expiry_status, c.approval_status
      INTO v_can_replace, v_expiry_status, v_approval
    FROM public.driver_document_compliance_ssot c
    WHERE c.driver_id = p_driver_id
      AND c.document_type_id = p_document_type_id
    LIMIT 1;
    IF v_approval = 'approved'
       AND v_expiry_status IN ('approved_valid', 'expiring_soon')
       AND coalesce(v_can_replace, false) IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'REPLACEMENT_NOT_ALLOWED',
        'message', 'An approved document is still valid; replacement is not open yet'
      );
    END IF;
  END IF;

  -- Reuse the pending row on the confirmed vehicle. Do not reuse another vehicle's pending row.
  SELECT * INTO v_doc
  FROM public.documents d
  WHERE d.driver_id = p_driver_id
    AND d.document_type_id = p_document_type_id
    AND d.is_current = true
    AND d.status = 'pending'
    AND (
      NOT public.is_vehicle_scoped_document_slug(v_dtype.slug)
      OR p_vehicle_id IS NULL
      OR d.vehicle_id = p_vehicle_id
    )
  ORDER BY d.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    -- Same-side resubmit on pending: create a fresh pending current row (supersession).
    IF EXISTS (
      SELECT 1 FROM public.document_attachments da
      WHERE da.document_id = v_doc.id
        AND da.side = v_side
        AND da.is_current = true
    ) THEN
      v_reuse_pending := false;
    ELSE
      v_reuse_pending := true;
    END IF;
  END IF;

  IF v_reuse_pending THEN
    -- Refresh expiry / audit on the pending shell when attaching another side.
    UPDATE public.documents
       SET expiry_date = coalesce(p_expiry_date, expiry_date),
           upload_source = 'admin',
           uploaded_by = v_uid,
           admin_staff_id = v_staff.id,
           uploaded_at = coalesce(uploaded_at, v_now),
           updated_at = v_now,
           status = 'pending',
           reviewed_by = NULL,
           reviewed_at = NULL,
           rejection_reason = NULL
     WHERE id = v_doc.id
    RETURNING * INTO v_doc;
  ELSE
    INSERT INTO public.documents (
      driver_id,
      document_type,
      document_type_id,
      document_name,
      status,
      expiry_date,
      is_current,
      file_url,
      submission_idempotency_key,
      upload_source,
      uploaded_by,
      admin_staff_id,
      uploaded_at
    ) VALUES (
      p_driver_id,
      v_dtype.slug,
      v_dtype.id,
      v_dtype.name,
      'pending',
      p_expiry_date,
      true,
      NULL,
      p_idempotency_key,
      'admin',
      v_uid,
      v_staff.id,
      v_now
    )
    RETURNING * INTO v_doc;
  END IF;

  -- Force pending even if a trigger/admin bypass tried otherwise.
  IF v_doc.status IS DISTINCT FROM 'pending' THEN
    UPDATE public.documents
       SET status = 'pending',
           reviewed_by = NULL,
           reviewed_at = NULL
     WHERE id = v_doc.id
    RETURNING * INTO v_doc;
  END IF;

  INSERT INTO public.document_attachments (
    document_id,
    driver_id,
    document_type,
    document_type_id,
    side,
    storage_path,
    file_url,
    mime_type,
    original_filename,
    file_size_bytes,
    is_current,
    submission_idempotency_key
  ) VALUES (
    v_doc.id,
    p_driver_id,
    v_dtype.slug,
    v_dtype.id,
    v_side,
    v_path,
    v_path,
    p_mime_type,
    p_original_filename,
    p_file_size_bytes,
    true,
    p_idempotency_key
  )
  RETURNING id INTO v_att_id;

  -- Demote prior current attachments of the same side on this document.
  UPDATE public.document_attachments
     SET is_current = false,
         superseded_by = v_att_id,
         updated_at = v_now
   WHERE document_id = v_doc.id
     AND side = v_side
     AND id IS DISTINCT FROM v_att_id
     AND is_current = true;

  BEGIN
    PERFORM public.sync_document_primary_file_url(v_doc.id);
  EXCEPTION WHEN undefined_function THEN
    -- sync helper is remote-managed; fall back to primary path on the document.
    UPDATE public.documents
       SET file_url = v_path,
           updated_at = v_now
     WHERE id = v_doc.id;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'document_id', v_doc.id,
    'attachment_id', v_att_id,
    'status', 'pending',
    'upload_source', 'admin',
    'admin_staff_id', v_staff.id,
    'side', v_side
  );
END;
$fn$;

COMMENT ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid, uuid) IS
  'Admin-assisted document submit. A provided p_vehicle_id attaches a vehicle document to that owned registration. An omitted p_vehicle_id keeps the previous stamp target so the current Admin client can still upload. Driver-scoped types ignore it. Always pending review.';

REVOKE ALL ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid, uuid) TO authenticated, service_role;

COMMIT;
