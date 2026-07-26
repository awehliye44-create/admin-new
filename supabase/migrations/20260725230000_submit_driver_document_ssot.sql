-- Driver document submission SSOT (upload/replace completion).
-- Extends existing documents + driver-documents architecture with a
-- backend-authoritative submit contract. Does not invent new buckets/statuses.

-- 1) Idempotency support for safe retries
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS submission_idempotency_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS documents_driver_submission_idempotency_uidx
  ON public.documents (driver_id, submission_idempotency_key)
  WHERE submission_idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.documents.submission_idempotency_key IS
  'Client-supplied idempotency key for submit_driver_document; unique per driver when present.';

-- 2) Tighten private driver-documents bucket MIME/size (was unlimited)
UPDATE storage.buckets
SET
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]
WHERE id = 'driver-documents';

-- 3) Guard: non-admin writers cannot set approval/review metadata
CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean;
BEGIN
  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  -- Service-role / system migrations: auth.uid() null with service_role
  IF auth.uid() IS NULL AND auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  NEW.status := 'pending';
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  -- Keep rejection_reason only when an admin previously set it on OLD;
  -- driver resubmits always clear it.
  IF TG_OP = 'INSERT' THEN
    NEW.rejection_reason := NULL;
  ELSE
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_driver_document_writes ON public.documents;
CREATE TRIGGER trg_guard_driver_document_writes
BEFORE INSERT OR UPDATE ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.guard_driver_document_writes();

-- 4) Authoritative submit/replace RPC
CREATE OR REPLACE FUNCTION public.submit_driver_document(
  p_document_type_id uuid,
  p_storage_path text,
  p_expiry_date date DEFAULT NULL,
  p_original_filename text DEFAULT NULL,
  p_mime_type text DEFAULT NULL,
  p_file_size_bytes bigint DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'storage'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_type record;
  v_ssot record;
  v_path text;
  v_object record;
  v_mime text;
  v_size bigint;
  v_today date := public.driver_compliance_today_london();
  v_existing_id uuid;
  v_doc_id uuid;
  v_file_url text;
  v_project_url text;
  v_allowed_mime text[] := ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf'
  ];
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

  v_path := trim(both '/' from trim(p_storage_path));
  IF v_path = '' OR v_path LIKE '%..%' OR split_part(v_path, '/', 1) IS DISTINCT FROM v_uid::text THEN
    RETURN jsonb_build_object('ok', false, 'error', 'STORAGE_PATH_FORBIDDEN', 'message', 'storage path must be under the authenticated user folder');
  END IF;

  -- Idempotent replay
  IF p_idempotency_key IS NOT NULL THEN
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

  SELECT dt.id, dt.slug, dt.name, dt.has_expiry, dt.is_active, dt.show_in_driver_app
    INTO v_type
  FROM public.document_types dt
  WHERE dt.id = p_document_type_id
  LIMIT 1;

  IF v_type.id IS NULL OR v_type.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DOCUMENT_TYPE_INVALID', 'message', 'document type is not active');
  END IF;

  -- Requirement must apply to this driver via SSOT (service-area aware)
  SELECT s.document_type_id, s.document_type_key, s.display_name, s.has_expiry, s.expiry_status, s.approval_status
    INTO v_ssot
  FROM public.driver_document_compliance_ssot s
  WHERE s.driver_id = v_driver_id
    AND s.document_type_id = p_document_type_id
  LIMIT 1;

  IF v_ssot.document_type_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REQUIREMENT_NOT_APPLICABLE', 'message', 'document requirement does not apply to this driver');
  END IF;

  -- Expiry rules from SSOT has_expiry
  IF coalesce(v_ssot.has_expiry, v_type.has_expiry, false) THEN
    IF p_expiry_date IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EXPIRY_REQUIRED', 'message', 'expiry date is required for this document');
    END IF;
    IF p_expiry_date < v_today THEN
      RETURN jsonb_build_object('ok', false, 'error', 'EXPIRY_IN_PAST', 'message', 'expiry date cannot be in the past');
    END IF;
  ELSE
    p_expiry_date := NULL;
  END IF;

  -- Verify uploaded object exists and belongs to this path
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

  -- Preserve historical file_url convention (public-style path; bucket is private — viewers must sign)
  v_project_url := 'https://thazislrdkjpvvghtvzo.supabase.co';
  v_file_url := v_project_url || '/storage/v1/object/public/driver-documents/' || v_path;

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
    v_file_url,
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

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'document_id', v_doc_id,
    'status', 'pending',
    'document_type_id', v_type.id,
    'document_type_key', v_type.slug,
    'file_url', v_file_url
  );
EXCEPTION
  WHEN unique_violation THEN
    -- Concurrent idempotent submit
    IF p_idempotency_key IS NOT NULL THEN
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
    RETURN jsonb_build_object('ok', false, 'error', 'CONFLICT', 'message', 'document submit conflict');
END;
$$;

REVOKE ALL ON FUNCTION public.submit_driver_document(uuid, text, date, text, text, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_driver_document(uuid, text, date, text, text, bigint, uuid) TO authenticated;

COMMENT ON FUNCTION public.submit_driver_document(uuid, text, date, text, text, bigint, uuid) IS
  'Driver-authoritative document submit/replace. Resolves driver via current_driver_id(), validates SSOT requirement + auth-scoped storage path, creates pending row only.';
