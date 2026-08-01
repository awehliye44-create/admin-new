-- Driver document Front/Back attachments SSOT (local only — DO NOT deploy from this task).
-- Verdict B: documents already version via is_current/superseded_by, but only one
-- active file_url per (driver_id, document_type). This adds attachment rows with
-- stable side = front|back|full|other so Front and Back can coexist.
--
-- Hard rules:
--  * Replace supersedes only the same side
--  * Legacy documents.file_url remains readable (synced from primary attachment)
--  * Store private storage paths (no new public URLs)
--  * Never auto-approve; driver writes stay pending via existing guards
--  * RLS mirrors documents ownership
--  * Preferred approval rule (both Front+Back before Approved) is enforced in
--    Admin Document Review UI when attachment rows are present — NOT a DB trigger.
--    Legacy side=full (or null-era single file_url backfilled as full) remains approvable.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Attachments table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  document_type_id uuid NULL REFERENCES public.document_types(id) ON DELETE SET NULL,
  side text NOT NULL
    CHECK (side IN ('front', 'back', 'full', 'other')),
  storage_path text NOT NULL,
  -- Legacy-compatible locator: storage path (preferred) or historical URL string.
  file_url text NULL,
  original_filename text NULL,
  mime_type text NULL,
  file_size_bytes bigint NULL,
  is_current boolean NOT NULL DEFAULT true,
  superseded_by uuid NULL REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  submission_idempotency_key uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_attachments IS
  'Per-side files for a logical documents row. One current attachment per (document_id, side).';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_document_attachments_doc_side_current
  ON public.document_attachments(document_id, side)
  WHERE is_current = true;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_document_attachments_idempotency
  ON public.document_attachments(driver_id, submission_idempotency_key)
  WHERE submission_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_attachments_document_id
  ON public.document_attachments(document_id);

CREATE INDEX IF NOT EXISTS idx_document_attachments_driver_current
  ON public.document_attachments(driver_id, document_type)
  WHERE is_current = true;

DROP TRIGGER IF EXISTS update_document_attachments_updated_at ON public.document_attachments;
CREATE TRIGGER update_document_attachments_updated_at
BEFORE UPDATE ON public.document_attachments
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.document_attachments ENABLE ROW LEVEL SECURITY;

-- Mirror public.documents RLS (20260112132720): admin ALL + drivers SELECT own.
-- Production app_role is admin/moderator/user/driver/customer only — no staff/super_admin.
DROP POLICY IF EXISTS "Admins can manage document attachments" ON public.document_attachments;
CREATE POLICY "Admins can manage document attachments"
  ON public.document_attachments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS "Staff can read document attachments" ON public.document_attachments;

DROP POLICY IF EXISTS "Drivers can view own document attachments" ON public.document_attachments;
CREATE POLICY "Drivers can view own document attachments"
  ON public.document_attachments FOR SELECT TO authenticated
  USING (
    driver_id IN (
      SELECT d.id FROM public.drivers d WHERE d.user_id = auth.uid()
    )
  );

-- Drivers never insert/update attachments directly — submit_driver_document (security definer) owns writes.

-- ---------------------------------------------------------------------------
-- 2. Helpers: path extract + primary file sync
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.driver_document_storage_path_from_locator(p_locator text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text := trim(both FROM coalesce(p_locator, ''));
  v_match text;
BEGIN
  IF v = '' THEN
    RETURN NULL;
  END IF;

  v_match := substring(v from '/storage/v1/object/(?:public|sign)/driver-documents/(.+)$');
  IF v_match IS NOT NULL THEN
    RETURN split_part(v_match, '?', 1);
  END IF;

  v_match := substring(v from '/storage/v1/object/driver-documents/(.+)$');
  IF v_match IS NOT NULL THEN
    RETURN split_part(v_match, '?', 1);
  END IF;

  IF v ~* '^https?://' THEN
    RETURN NULL;
  END IF;

  RETURN trim(both '/' from split_part(v, '?', 1));
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_document_primary_attachment_locator(p_document_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(nullif(trim(a.file_url), ''), a.storage_path)
  FROM public.document_attachments a
  WHERE a.document_id = p_document_id
    AND a.is_current = true
  ORDER BY
    CASE a.side
      WHEN 'front' THEN 1
      WHEN 'full' THEN 2
      WHEN 'back' THEN 3
      ELSE 4
    END,
    a.updated_at DESC NULLS LAST,
    a.created_at DESC NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.sync_document_primary_file_url(p_document_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.documents d
  SET file_url = public.driver_document_primary_attachment_locator(p_document_id),
      updated_at = now()
  WHERE d.id = p_document_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.sync_document_primary_file_url(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Backfill legacy single file_url as side=full (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO public.document_attachments (
  document_id,
  driver_id,
  document_type,
  document_type_id,
  side,
  storage_path,
  file_url,
  original_filename,
  is_current,
  created_at,
  updated_at
)
SELECT
  d.id,
  d.driver_id,
  d.document_type,
  d.document_type_id,
  'full',
  coalesce(
    public.driver_document_storage_path_from_locator(d.file_url),
    d.file_url
  ),
  d.file_url,
  left(nullif(trim(d.notes), ''), 255),
  true,
  d.created_at,
  d.updated_at
FROM public.documents d
WHERE d.file_url IS NOT NULL
  AND length(trim(d.file_url)) > 0
  AND NOT EXISTS (
    SELECT 1
    FROM public.document_attachments a
    WHERE a.document_id = d.id
      AND a.side = 'full'
      AND a.is_current = true
  );

-- ---------------------------------------------------------------------------
-- 4. Current attachments helper view (admin + driver read)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.driver_document_attachments_ssot
WITH (security_invoker = on, security_barrier = true) AS
SELECT
  a.id AS attachment_id,
  a.document_id,
  a.driver_id,
  a.document_type,
  a.document_type_id,
  a.side,
  a.storage_path,
  coalesce(nullif(trim(a.file_url), ''), a.storage_path) AS file_url,
  a.original_filename,
  a.mime_type,
  a.file_size_bytes,
  a.is_current,
  a.superseded_by,
  a.created_at,
  a.updated_at
FROM public.document_attachments a
WHERE a.is_current = true;

GRANT SELECT ON public.driver_document_attachments_ssot TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. submit_driver_document — add p_side; pending may add/replace non-full sides
-- Drop prior overloads so PostgREST has a single unambiguous signature.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_driver_document(uuid, text, date, text, text, bigint, uuid);
DROP FUNCTION IF EXISTS public.submit_driver_document(uuid, text, date, text, text, bigint, uuid, text);

CREATE OR REPLACE FUNCTION public.submit_driver_document(
  p_document_type_id uuid,
  p_storage_path text,
  p_expiry_date date DEFAULT NULL::date,
  p_original_filename text DEFAULT NULL::text,
  p_mime_type text DEFAULT NULL::text,
  p_file_size_bytes bigint DEFAULT NULL::bigint,
  p_idempotency_key uuid DEFAULT NULL::uuid,
  p_side text DEFAULT 'full'::text
)
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

  SELECT s.document_type_id, s.document_type_key, s.display_name, s.has_expiry, s.expiry_status, s.approval_status, s.document_id
    INTO v_ssot
  FROM public.driver_document_compliance_ssot s
  WHERE s.driver_id = v_driver_id
    AND s.document_type_id = p_document_type_id
  LIMIT 1;

  IF v_ssot.document_type_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'REQUIREMENT_NOT_APPLICABLE', 'message', 'document requirement does not apply to this driver');
  END IF;

  -- Pending: allow add/replace of front|back|other on the current logical document.
  -- Full-side replace while pending stays blocked (legacy single-file behaviour).
  IF lower(coalesce(v_ssot.expiry_status, '')) = 'pending' THEN
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
  ELSIF lower(coalesce(v_ssot.expiry_status, '')) IN ('approved_valid', 'expiring_soon') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'RENEWAL_NOT_ALLOWED',
      'message', 'Upload is only allowed after this document has expired.'
    );
  ELSIF lower(coalesce(v_ssot.expiry_status, '')) NOT IN ('missing', 'rejected', 'expired') THEN
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

REVOKE ALL ON FUNCTION public.submit_driver_document(uuid, text, date, text, text, bigint, uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_driver_document(uuid, text, date, text, text, bigint, uuid, text) TO authenticated;

-- Soft display rename (UK spelling) — does not change slug.
UPDATE public.document_types
SET name = 'DVLA Driving Licence (Pink Card — Front & Back)',
    updated_at = now()
WHERE slug = 'dvla_driving_license'
  AND name IS DISTINCT FROM 'DVLA Driving Licence (Pink Card — Front & Back)';

COMMIT;
