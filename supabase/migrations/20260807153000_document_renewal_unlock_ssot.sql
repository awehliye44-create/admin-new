-- Document renewal unlock SSOT
-- Unlock Update/Replace at MAX(document_types.reminder_days_before_expiry),
-- not only after expiry. Driver reads can_upload_replacement from this view.

CREATE OR REPLACE FUNCTION public.document_type_renewal_open_days(p_reminder_days integer[])
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    (SELECT MAX(x) FROM unnest(COALESCE(p_reminder_days, ARRAY[]::integer[])) AS t(x)),
    0
  );
$$;

COMMENT ON FUNCTION public.document_type_renewal_open_days(integer[]) IS
  'Authoritative renewal unlock window in days = MAX(Admin Reminder Schedule).';

DROP VIEW IF EXISTS public.driver_document_compliance_ssot CASCADE;

CREATE VIEW public.driver_document_compliance_ssot
WITH (security_invoker = on, security_barrier = true) AS
WITH current_docs AS (
  SELECT d.driver_id, d.document_type, d.id AS document_id, d.status, d.expiry_date,
         d.file_url, d.updated_at, d.is_current, d.superseded_by
  FROM public.documents d
  WHERE d.is_current = true
),
today_london AS (
  SELECT (now() AT TIME ZONE 'Europe/London')::date AS today
)
SELECT
  dr.id                                        AS driver_id,
  dt.id                                        AS document_type_id,
  dt.slug                                      AS document_type_key,
  dt.name                                      AS display_name,
  dt.is_required,
  dt.has_expiry,
  cd.document_id,
  cd.status                                    AS approval_status,
  cd.expiry_date,
  cd.file_url,
  cd.updated_at                                AS last_updated_at,
  cd.superseded_by                             AS replacement_document_id,
  COALESCE(cd.is_current, false)               AS is_current,
  (cd.document_id IS NOT NULL AND cd.is_current = false) AS is_superseded,
  public.document_type_renewal_open_days(dt.reminder_days_before_expiry)
                                               AS renewal_open_days,
  CASE WHEN cd.expiry_date IS NULL THEN NULL
       ELSE (cd.expiry_date - (SELECT today FROM today_london)) END
                                               AS days_until_expiry,
  CASE
    WHEN cd.document_id IS NULL                                             THEN 'missing'
    WHEN lower(coalesce(cd.status,'')) IN ('rejected','declined')           THEN 'rejected'
    WHEN lower(coalesce(cd.status,'')) IN ('pending','uploaded','submitted','under_review')
                                                                            THEN 'pending'
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND cd.expiry_date < (SELECT today FROM today_london)              THEN 'expired'
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND lower(coalesce(cd.status,'')) = 'approved'
         AND cd.expiry_date <= (
               (SELECT today FROM today_london)
               + make_interval(days => public.document_type_renewal_open_days(dt.reminder_days_before_expiry))
             )::date
                                                                            THEN 'expiring_soon'
    WHEN lower(coalesce(cd.status,'')) = 'approved'                         THEN 'approved_valid'
    ELSE 'pending'
  END                                          AS expiry_status,
  CASE
    WHEN cd.document_id IS NULL                                             THEN 'missing'
    WHEN lower(coalesce(cd.status,'')) IN ('rejected','declined')           THEN 'rejected'
    WHEN lower(coalesce(cd.status,'')) IN ('pending','uploaded','submitted','under_review')
                                                                            THEN 'pending_review'
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND cd.expiry_date < (SELECT today FROM today_london)              THEN 'expired'
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND lower(coalesce(cd.status,'')) = 'approved'
         AND cd.expiry_date <= (
               (SELECT today FROM today_london)
               + make_interval(days => public.document_type_renewal_open_days(dt.reminder_days_before_expiry))
             )::date
                                                                            THEN 'expiring'
    WHEN lower(coalesce(cd.status,'')) = 'approved'                         THEN 'valid'
    ELSE 'pending_review'
  END                                          AS renewal_state,
  CASE
    WHEN cd.document_id IS NULL THEN true
    WHEN lower(coalesce(cd.status,'')) IN ('rejected','declined') THEN true
    WHEN lower(coalesce(cd.status,'')) IN ('pending','uploaded','submitted','under_review')
      THEN false
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND cd.expiry_date < (SELECT today FROM today_london) THEN true
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND lower(coalesce(cd.status,'')) = 'approved'
         AND (cd.expiry_date - (SELECT today FROM today_london))
             <= public.document_type_renewal_open_days(dt.reminder_days_before_expiry)
      THEN true
    ELSE false
  END                                          AS can_upload_replacement,
  (
    dt.is_required
    AND (
      cd.document_id IS NULL
      OR lower(coalesce(cd.status,'')) IN ('rejected','declined')
      OR (dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (SELECT today FROM today_london))
    )
  )                                            AS blocks_online
FROM public.drivers dr
CROSS JOIN public.document_types dt
LEFT JOIN current_docs cd
  ON cd.driver_id = dr.id AND cd.document_type = dt.slug
WHERE dt.is_active = true
  AND (dt.is_required = true OR cd.document_id IS NOT NULL);

COMMENT ON COLUMN public.driver_document_compliance_ssot.renewal_open_days IS
  'MAX(document_types.reminder_days_before_expiry) — Admin Reminder Schedule unlock window.';
COMMENT ON COLUMN public.driver_document_compliance_ssot.can_upload_replacement IS
  'Authoritative Driver Update/Replace unlock. Never recompute in the client.';
COMMENT ON COLUMN public.driver_document_compliance_ssot.renewal_state IS
  'valid | expiring | expired | pending_review | rejected | missing';

GRANT SELECT ON public.driver_document_compliance_ssot TO authenticated;

CREATE OR REPLACE FUNCTION public.get_driver_document_compliance(_driver_id uuid DEFAULT NULL)
RETURNS SETOF public.driver_document_compliance_ssot
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid;
  v_is_privileged boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  v_is_privileged := public.has_role(v_uid, 'admin')
                  OR public.has_role(v_uid, 'staff')
                  OR public.has_role(v_uid, 'super_admin');

  IF _driver_id IS NOT NULL THEN
    IF NOT v_is_privileged THEN
      SELECT id INTO v_target FROM public.drivers WHERE user_id = v_uid LIMIT 1;
      IF v_target IS NULL OR v_target <> _driver_id THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
      END IF;
    END IF;
    v_target := _driver_id;
  ELSE
    SELECT id INTO v_target FROM public.drivers WHERE user_id = v_uid LIMIT 1;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'no_driver_profile' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.driver_document_compliance_ssot
  WHERE driver_id = v_target
  ORDER BY
    CASE expiry_status
      WHEN 'expired'        THEN 1
      WHEN 'rejected'       THEN 2
      WHEN 'missing'        THEN 3
      WHEN 'expiring_soon'  THEN 4
      WHEN 'pending'        THEN 5
      WHEN 'approved_valid' THEN 6
      ELSE 7
    END,
    display_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO authenticated;

-- Unlock submit_driver_document within Admin reminder window
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
    -- Unlock when SSOT can_upload_replacement is true (MAX(reminder_days_before_expiry) window).
    IF NOT coalesce(v_ssot.can_upload_replacement, false) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'RENEWAL_NOT_ALLOWED',
        'message', 'Upload opens when the Admin reminder window starts, or after expiry.'
      );
    END IF;
    -- Fall through to insert a pending replacement; current approved stays compliant until review/expiry.
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
$function$
