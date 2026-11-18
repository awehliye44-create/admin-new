-- Follow-up: align admin_submit_driver_document attachment sides with Driver SSOT.
-- document_attachments_side_check allows front|back|full|other only.
-- Do not widen that CHECK. Legacy Admin p_side='single' normalises to 'full'.
-- Authz, registration verification, storage ownership, and replacement rules unchanged.

CREATE OR REPLACE FUNCTION public.admin_submit_driver_document(
  p_driver_id uuid,
  p_document_type_id uuid,
  p_storage_path text,
  p_side text DEFAULT 'front',
  p_expiry_date date DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_original_filename text DEFAULT NULL,
  p_file_size_bytes bigint DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
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
    WHERE da.submission_idempotency_key = p_idempotency_key::text
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

  -- Replacement rules from compliance SSOT — same behaviour as Driver App.
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

  -- Reuse current pending document for the other side; otherwise insert a new current pending row.
  SELECT * INTO v_doc
  FROM public.documents d
  WHERE d.driver_id = p_driver_id
    AND d.document_type_id = p_document_type_id
    AND d.is_current = true
    AND d.status = 'pending'
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
      CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key::text ELSE NULL END,
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
    CASE WHEN p_idempotency_key IS NOT NULL THEN p_idempotency_key::text ELSE NULL END
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

COMMENT ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) IS
  'Admin-assisted document submit. Requires documents.admin_upload + driver registration verification. Always pending review; attachment sides match Driver SSOT (front|back|full|other; legacy single→full).';

REVOKE ALL ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_submit_driver_document(uuid, uuid, text, text, date, text, text, bigint, uuid) TO service_role;
