-- Fix PHV dual-side sides_on_file for pending replacement vehicles.
-- Root cause: My Documents SSOT is trip-active scoped (20270305110000), so
-- submit_driver_document treated each replacement side as a new document and
-- demoted the other side. Driver applicable-docs then only saw one (or none).
-- Do not apply to hosted/production until authenticated non-prod E2E.
-- Lifecycle contracts remain verified:false.

CREATE OR REPLACE FUNCTION public.submit_driver_document(p_document_type_id uuid, p_storage_path text, p_expiry_date date DEFAULT NULL::date, p_original_filename text DEFAULT NULL::text, p_mime_type text DEFAULT NULL::text, p_file_size_bytes bigint DEFAULT NULL::bigint, p_idempotency_key uuid DEFAULT NULL::uuid, p_side text DEFAULT 'full'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'storage'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_type record;
  v_ssot record;
  v_rule record;
  v_sa_id uuid;
  v_path text;
  v_object record;
  v_mime text;
  v_size bigint;
  v_today date := public.driver_compliance_today_london();
  v_existing_id uuid;
  v_existing_attachment_id uuid;
  v_doc_id uuid;
  v_attachment_id uuid;
  v_file_locator text;
  v_allowed_mime text[] := ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf'
  ];
  v_expiry_required boolean;
  v_side text;
  v_attach_only boolean := false;
  v_prev_attachment_id uuid;
  v_upload_target uuid;
  v_target_doc_id uuid;
  v_target_doc_status text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED', 'message', 'Authentication required');
  END IF;

  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DRIVER_NOT_FOUND', 'message', 'Driver profile not found for this account');
  END IF;

  IF p_document_type_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DOCUMENT_TYPE_REQUIRED', 'message', 'document type id is required');
  END IF;

  IF p_storage_path IS NULL OR length(trim(p_storage_path)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STORAGE_PATH_REQUIRED', 'message', 'storage path is required');
  END IF;

  v_side := lower(trim(coalesce(p_side, 'full')));
  IF v_side IN ('', 'none') THEN
    v_side := 'full';
  END IF;
  IF v_side NOT IN ('front', 'back', 'full', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SIDE_INVALID', 'message', 'side must be front, back, full, or other');
  END IF;

  v_path := trim(both '/' from trim(p_storage_path));
  IF v_path = '' OR v_path LIKE '%..%' OR split_part(v_path, '/', 1) IS DISTINCT FROM v_uid::text THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STORAGE_PATH_FORBIDDEN', 'message', 'storage path must be under the authenticated user folder');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT a.id, a.document_id
      INTO v_existing_attachment_id, v_existing_id
    FROM public.document_attachments a
    WHERE a.driver_id = v_driver_id
      AND a.submission_idempotency_key = p_idempotency_key
    LIMIT 1;
    IF v_existing_attachment_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'document_id', v_existing_id,
        'attachment_id', v_existing_attachment_id,
        'side', v_side,
        'status', 'pending'
      );
    END IF;

    SELECT d.id INTO v_existing_id
    FROM public.documents d
    WHERE d.driver_id = v_driver_id
      AND d.submission_idempotency_key = p_idempotency_key
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', true,
        'idempotent', true,
        'document_id', v_existing_id,
        'status', 'pending'
      );
    END IF;
  END IF;

  SELECT dt.id, dt.slug, dt.name, dt.has_expiry, dt.is_active
    INTO v_type
  FROM public.document_types dt
  WHERE dt.id = p_document_type_id
  LIMIT 1;

  IF v_type.id IS NULL OR v_type.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DOCUMENT_TYPE_INVALID', 'message', 'document type is not active');
  END IF;

  SELECT dsa.service_area_id INTO v_sa_id
  FROM public.driver_service_areas dsa
  WHERE dsa.driver_id = v_driver_id
  ORDER BY dsa.created_at NULLS LAST
  LIMIT 1;

  IF v_sa_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SERVICE_AREA_MISSING', 'message', 'Driver has no assigned service area');
  END IF;

  SELECT r.doc_type_id, r.display_in_driver_app, r.mandatory, r.expiry_required, r.is_active
    INTO v_rule
  FROM public.service_area_document_rules r
  WHERE r.service_area_id = v_sa_id
    AND r.doc_type_id = p_document_type_id
  LIMIT 1;

  IF v_rule.doc_type_id IS NULL OR v_rule.is_active IS NOT TRUE OR v_rule.display_in_driver_app IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'REQUIREMENT_NOT_VISIBLE',
      'message', 'This document is not assigned to your service area for the Driver app'
    );
  END IF;

  SELECT s.document_type_id, s.document_type_key, s.display_name, s.has_expiry, s.expiry_status, s.approval_status, s.document_id, s.can_upload_replacement
    INTO v_ssot
  FROM public.driver_document_compliance_ssot s
  WHERE s.driver_id = v_driver_id
    AND s.document_type_id = p_document_type_id
  LIMIT 1;

  IF v_ssot.document_type_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REQUIREMENT_NOT_APPLICABLE', 'message', 'document requirement does not apply to this driver');
  END IF;

  -- Pending replacement vehicle: My Documents SSOT is trip-active scoped (110000),
  -- so dual-side uploads must reuse the pending current row on the upload TARGET
  -- vehicle. Otherwise each side INSERT demotes the other and sides_on_file breaks.
  IF public.is_vehicle_scoped_document_slug(v_type.slug) THEN
    v_upload_target := public.resolve_vehicle_document_target(v_driver_id);
    IF v_upload_target IS NOT NULL THEN
      SELECT d.id, lower(coalesce(d.status, ''))
        INTO v_target_doc_id, v_target_doc_status
        FROM public.documents d
       WHERE d.driver_id = v_driver_id
         AND d.document_type = v_type.slug
         AND d.vehicle_id IS NOT DISTINCT FROM v_upload_target
         AND COALESCE(d.is_current, true) = true
       ORDER BY d.created_at DESC
       LIMIT 1;

      IF v_target_doc_id IS NOT NULL
         AND v_target_doc_status IN ('pending', 'uploaded', 'submitted', 'under_review') THEN
        IF v_side = 'full' THEN
          RETURN jsonb_build_object(
            'ok', false,
            'error', 'ALREADY_PENDING',
            'message', 'This document is awaiting review. Replacement is not available yet.'
          );
        END IF;
        v_attach_only := true;
        v_doc_id := v_target_doc_id;
      ELSIF v_target_doc_id IS NULL
         OR v_target_doc_status IN ('rejected', 'declined', 'expired') THEN
        -- First side (or re-upload after reject) onto the replacement vehicle.
        v_attach_only := false;
        -- Skip trip-active SSOT gates below; target vehicle is the authority.
        v_ssot.expiry_status := 'missing';
      END IF;
    END IF;
  END IF;

  -- Pending: allow add/replace of front|back|other on the current logical document.
  -- Full-side replace while pending stays blocked (legacy single-file behaviour).
  IF NOT v_attach_only AND lower(coalesce(v_ssot.expiry_status, '')) = 'pending' THEN
    IF v_side = 'full' THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'ALREADY_PENDING',
        'message', 'This document is awaiting review. Replacement is not available yet.'
      );
    END IF;
    IF v_ssot.document_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'PENDING_DOCUMENT_MISSING',
        'message', 'Pending document row was not found.'
      );
    END IF;
    v_attach_only := true;
    v_doc_id := v_ssot.document_id;
  ELSIF NOT v_attach_only AND lower(coalesce(v_ssot.expiry_status, '')) IN ('approved_valid', 'expiring_soon') THEN
    -- Unlock when SSOT can_upload_replacement is true (MAX(reminder_days_before_expiry) window).
    IF NOT coalesce(v_ssot.can_upload_replacement, false) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'RENEWAL_NOT_ALLOWED',
        'message', 'Upload opens when the Admin reminder window starts, or after expiry.'
      );
    END IF;
    -- Fall through to insert a pending replacement; current approved stays compliant until review/expiry.
  ELSIF NOT v_attach_only AND lower(coalesce(v_ssot.expiry_status, '')) NOT IN ('missing', 'rejected', 'expired') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'UPLOAD_NOT_ALLOWED',
      'message', 'This document cannot be uploaded in its current status.'
    );
  END IF;

  v_expiry_required := coalesce(v_rule.expiry_required, v_ssot.has_expiry, v_type.has_expiry, false);
  IF v_expiry_required THEN
    IF p_expiry_date IS NULL AND NOT v_attach_only THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EXPIRY_REQUIRED', 'message', 'expiry date is required for this document');
    END IF;
    IF p_expiry_date IS NOT NULL AND p_expiry_date < v_today THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EXPIRY_IN_PAST', 'message', 'expiry date cannot be in the past');
    END IF;
  ELSE
    p_expiry_date := NULL;
  END IF;

  SELECT o.name, o.metadata INTO v_object
  FROM storage.objects o
  WHERE o.bucket_id = 'driver-documents'
    AND o.name = v_path
  LIMIT 1;

  IF v_object.name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STORAGE_OBJECT_MISSING', 'message', 'uploaded file was not found in driver-documents storage');
  END IF;

  v_mime := lower(coalesce(nullif(trim(p_mime_type), ''), v_object.metadata->>'mimetype', ''));
  IF v_mime = 'image/jpg' THEN
    v_mime := 'image/jpeg';
  END IF;
  IF v_mime = '' OR NOT (v_mime = ANY (v_allowed_mime)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MIME_NOT_ALLOWED', 'message', 'unsupported file type');
  END IF;

  v_size := coalesce(p_file_size_bytes, nullif(v_object.metadata->>'size', '')::bigint);
  IF v_size IS NULL OR v_size <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FILE_SIZE_INVALID', 'message', 'file size is missing or invalid');
  END IF;
  IF v_size > 10485760 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FILE_TOO_LARGE', 'message', 'file exceeds 10 MB limit');
  END IF;

  -- Private bucket: store path only (clients create signed URLs).
  v_file_locator := v_path;

  IF NOT v_attach_only THEN
    INSERT INTO public.documents (
      driver_id,
      document_type,
      document_type_id,
      document_name,
      file_url,
      status,
      expiry_date,
      is_current,
      rejection_reason,
      reviewed_by,
      reviewed_at,
      submission_idempotency_key,
      notes
    ) VALUES (
      v_driver_id,
      v_type.slug,
      v_type.id,
      coalesce(nullif(trim(v_ssot.display_name), ''), v_type.name),
      v_file_locator,
      'pending',
      p_expiry_date,
      true,
      NULL,
      NULL,
      NULL,
      p_idempotency_key,
      CASE
        WHEN p_original_filename IS NULL THEN NULL
        ELSE left(trim(p_original_filename), 255)
      END
    )
    RETURNING id INTO v_doc_id;
  ELSE
    -- Keep pending; never auto-approve. Optionally refresh expiry when provided.
    UPDATE public.documents d
    SET
      expiry_date = CASE
        WHEN v_expiry_required AND p_expiry_date IS NOT NULL THEN p_expiry_date
        ELSE d.expiry_date
      END,
      status = 'pending',
      rejection_reason = NULL,
      reviewed_by = NULL,
      reviewed_at = NULL,
      updated_at = now()
    WHERE d.id = v_doc_id;
  END IF;

  -- Supersede only the same side on this logical document.
  SELECT a.id INTO v_prev_attachment_id
  FROM public.document_attachments a
  WHERE a.document_id = v_doc_id
    AND a.side = v_side
    AND a.is_current = true
  LIMIT 1;

  IF v_prev_attachment_id IS NOT NULL THEN
    UPDATE public.document_attachments
    SET is_current = false,
        updated_at = now()
    WHERE id = v_prev_attachment_id;
  END IF;

  INSERT INTO public.document_attachments (
    document_id,
    driver_id,
    document_type,
    document_type_id,
    side,
    storage_path,
    file_url,
    original_filename,
    mime_type,
    file_size_bytes,
    is_current,
    submission_idempotency_key
  ) VALUES (
    v_doc_id,
    v_driver_id,
    v_type.slug,
    v_type.id,
    v_side,
    v_path,
    v_file_locator,
    CASE
      WHEN p_original_filename IS NULL THEN NULL
      ELSE left(trim(p_original_filename), 255)
    END,
    v_mime,
    v_size,
    true,
    p_idempotency_key
  )
  RETURNING id INTO v_attachment_id;

  IF v_prev_attachment_id IS NOT NULL THEN
    UPDATE public.document_attachments
    SET superseded_by = v_attachment_id,
        updated_at = now()
    WHERE id = v_prev_attachment_id;
  END IF;

  PERFORM public.sync_document_primary_file_url(v_doc_id);

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'document_id', v_doc_id,
    'attachment_id', v_attachment_id,
    'side', v_side,
    'status', 'pending',
    'document_type_id', v_type.id,
    'document_type_key', v_type.slug,
    'file_url', public.driver_document_primary_attachment_locator(v_doc_id)
  );
EXCEPTION
  WHEN unique_violation THEN
    IF p_idempotency_key IS NOT NULL THEN
      SELECT a.id, a.document_id
        INTO v_existing_attachment_id, v_existing_id
      FROM public.document_attachments a
      WHERE a.driver_id = v_driver_id
        AND a.submission_idempotency_key = p_idempotency_key
      LIMIT 1;
      IF v_existing_attachment_id IS NOT NULL THEN
        RETURN jsonb_build_object(
          'ok', true,
          'idempotent', true,
          'document_id', v_existing_id,
          'attachment_id', v_existing_attachment_id,
          'side', v_side,
          'status', 'pending'
        );
      END IF;
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', 'CONFLICT', 'message', 'document submit conflict');
END;
$function$;

CREATE OR REPLACE FUNCTION public.vehicle_change_applicable_documents(p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- Aggregate current front/back attachments for this vehicle+type.
    -- Dual-side recovery must see sides even if a prior bug demoted one side's
    -- document row; never read the trip-active / original vehicle.
    v_sides := ARRAY[]::text[];
    SELECT coalesce(
             array_agg(DISTINCT da.side ORDER BY da.side),
             ARRAY[]::text[]
           )
      INTO v_sides
      FROM public.document_attachments da
      JOIN public.documents d_side ON d_side.id = da.document_id
     WHERE d_side.driver_id = p_driver_id
       AND d_side.document_type = v_slug
       AND (v_target IS NULL OR d_side.vehicle_id IS NOT DISTINCT FROM v_target)
       AND coalesce(da.is_current, true) = true
       AND da.side IN ('front', 'back');
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
$function$;

COMMENT ON FUNCTION public.submit_driver_document(uuid, text, date, text, text, bigint, uuid, text) IS
  'Driver document submit. Vehicle-scoped pending replacement reuses the target vehicle current pending row for front/back attach so sides_on_file stays complete.';

COMMENT ON FUNCTION public.vehicle_change_applicable_documents(uuid) IS
  'Replacement vehicle document requirements. sides_on_file aggregates current front/back attachments for the upload-target vehicle only.';
