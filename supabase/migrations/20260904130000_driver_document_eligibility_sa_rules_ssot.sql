-- Driver document compliance SSOT:
-- Eligibility and My Documents must use service_area_document_rules, not global
-- document_types defaults.
--
-- A rule blocks online only when:
--   rule.is_active = true
--   AND rule.mandatory = true
--   AND (
--     approved upload missing
--     OR approval state is blocking
--     OR (
--       rule.expiry_required = true
--       AND (expiry missing OR expiry < today_london)
--     )
--   )
--
-- display_in_driver_app controls visibility only — not mandatory blocking.
-- Inactive / optional / no-expiry-null must never block Go Online.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_service_area_id uuid;
  v_service_area_name text;
  v_rules_configured boolean;
  v_today_london date;
  v_warn_days integer := 7;
  v_required_slugs text[] := ARRAY[]::text[];
  v_missing text[] := ARRAY[]::text[];
  v_expired text[] := ARRAY[]::text[];
  v_expiry_missing text[] := ARRAY[]::text[];
  v_pending text[] := ARRAY[]::text[];
  v_rejected text[] := ARRAY[]::text[];
  v_expiring text[] := ARRAY[]::text[];
  v_hash_parts text[] := ARRAY[]::text[];
  v_blocking_docs jsonb := '[]'::jsonb;
  v_doc_type_id uuid;
  v_slug text;
  v_label text;
  v_status text;
  v_expiry date;
  v_expiry_required boolean;
  v_document_status text;
  v_compliance_hash text;
  v_rule_version text;
  v_should_open boolean;
  v_approved boolean;
  v_blocking_reason text;
  v_block_reason_one text;
BEGIN
  v_today_london := public.driver_compliance_today_london();

  BEGIN
    SELECT GREATEST(1, (setting_value->>0)::integer)
    INTO v_warn_days
    FROM public.admin_settings
    WHERE setting_key = 'document_expiry_reminder_days'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_warn_days := 7;
  END;

  SELECT d.service_area_id, sa.name
  INTO v_service_area_id, v_service_area_name
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = d.service_area_id
  WHERE d.id = p_driver_id;

  IF v_service_area_id IS NULL THEN
    v_compliance_hash := p_driver_id::text || '|none|service_area_not_assigned|';
    RETURN jsonb_build_object(
      'approved', false,
      'eligible', false,
      'document_status', 'service_area_not_assigned',
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'blocking_reason', 'missing_required_document',
      'message', 'Driver has no assigned service area. Assign a service area before going online.',
      'service_area_id', null,
      'service_area_name', null,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'expiry_missing_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb,
      'expiring_soon_documents', '[]'::jsonb,
      'blocking_documents', '[]'::jsonb,
      'compliance_hash', v_compliance_hash,
      'rule_version', 'none',
      'should_open_documents', true,
      'should_notify', false
    );
  END IF;

  -- Rules exist only when at least one active rule is configured.
  SELECT EXISTS(
    SELECT 1 FROM public.service_area_document_rules sar
    WHERE sar.service_area_id = v_service_area_id
      AND sar.is_active = true
  ) INTO v_rules_configured;

  SELECT COALESCE(
    md5(string_agg(
      sar.id::text || ':' || sar.is_active::text || ':' || sar.mandatory::text || ':' ||
      COALESCE(sar.display_in_driver_app, true)::text || ':' || COALESCE(sar.expiry_required, true)::text,
      ',' ORDER BY sar.id
    )),
    'empty'
  )
  INTO v_rule_version
  FROM public.service_area_document_rules sar
  WHERE sar.service_area_id = v_service_area_id;

  IF NOT v_rules_configured THEN
    v_compliance_hash := p_driver_id::text || '|' || v_service_area_id::text || '|rules_not_configured|' || v_rule_version;
    RETURN jsonb_build_object(
      'approved', false,
      'eligible', false,
      'document_status', 'rules_not_configured',
      'code', 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED',
      'blocking_reason', 'missing_required_document',
      'message', format(
        'Document rules are not configured for service area %s.',
        COALESCE(v_service_area_name, v_service_area_id::text)
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'expiry_missing_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb,
      'expiring_soon_documents', '[]'::jsonb,
      'blocking_documents', '[]'::jsonb,
      'compliance_hash', v_compliance_hash,
      'rule_version', v_rule_version,
      'should_open_documents', true,
      'should_notify', false
    );
  END IF;

  -- Mandatory active rules only. display_in_driver_app does NOT gate eligibility.
  FOR v_doc_type_id, v_slug, v_label, v_expiry_required IN
    SELECT dt.id, dt.slug, COALESCE(NULLIF(trim(dt.name), ''), dt.slug), COALESCE(sar.expiry_required, true)
    FROM public.service_area_document_rules sar
    JOIN public.document_types dt ON dt.id = sar.doc_type_id
    WHERE sar.service_area_id = v_service_area_id
      AND sar.is_active = true
      AND sar.mandatory = true
      AND COALESCE(dt.is_active, true) = true
    ORDER BY sar.sort_order NULLS LAST, dt.display_order NULLS LAST, dt.name
  LOOP
    v_required_slugs := array_append(v_required_slugs, v_slug);

    SELECT d.status, d.expiry_date
    INTO v_status, v_expiry
    FROM public.documents d
    WHERE d.driver_id = p_driver_id
      AND (
        d.document_type = v_slug
        OR d.document_type_id = v_doc_type_id
      )
    ORDER BY
      CASE WHEN COALESCE(d.is_current, true) THEN 0 ELSE 1 END,
      CASE WHEN lower(COALESCE(d.status, '')) = 'approved' THEN 0 ELSE 1 END,
      d.updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_status IS NULL THEN
      v_missing := array_append(v_missing, v_slug);
      v_hash_parts := array_append(v_hash_parts, v_slug || ':missing:');
      v_blocking_docs := v_blocking_docs || jsonb_build_array(jsonb_build_object(
        'documentTypeId', v_doc_type_id,
        'code', v_slug,
        'label', v_label,
        'reason', 'missing_required_document'
      ));
      CONTINUE;
    END IF;

    v_status := lower(trim(v_status));
    v_hash_parts := array_append(
      v_hash_parts,
      v_slug || ':' || v_status || ':' || COALESCE(v_expiry::text, '') || ':exp_req=' || v_expiry_required::text
    );

    IF v_status IN (
      'rejected', 'declined', 'resubmission_required', 'resubmit_required', 'requires_resubmission'
    ) THEN
      v_rejected := array_append(v_rejected, v_slug);
      v_blocking_docs := v_blocking_docs || jsonb_build_array(jsonb_build_object(
        'documentTypeId', v_doc_type_id,
        'code', v_slug,
        'label', v_label,
        'reason', 'document_rejected'
      ));
      CONTINUE;
    END IF;

    -- Non-approved uploads block as pending; never invent expiry failure first.
    IF v_status IS DISTINCT FROM 'approved' THEN
      v_pending := array_append(v_pending, v_slug);
      v_blocking_docs := v_blocking_docs || jsonb_build_array(jsonb_build_object(
        'documentTypeId', v_doc_type_id,
        'code', v_slug,
        'label', v_label,
        'reason', 'document_pending'
      ));
      CONTINUE;
    END IF;

    -- Approved + expiry_required=false: null expiry is valid.
    IF v_expiry_required THEN
      IF v_expiry IS NULL THEN
        v_expiry_missing := array_append(v_expiry_missing, v_slug);
        v_blocking_docs := v_blocking_docs || jsonb_build_array(jsonb_build_object(
          'documentTypeId', v_doc_type_id,
          'code', v_slug,
          'label', v_label,
          'reason', 'expiry_required_but_missing'
        ));
        CONTINUE;
      END IF;

      IF v_expiry < v_today_london THEN
        v_expired := array_append(v_expired, v_slug);
        v_blocking_docs := v_blocking_docs || jsonb_build_array(jsonb_build_object(
          'documentTypeId', v_doc_type_id,
          'code', v_slug,
          'label', v_label,
          'reason', 'document_expired'
        ));
        CONTINUE;
      END IF;

      IF v_expiry <= (v_today_london + v_warn_days) THEN
        v_expiring := array_append(v_expiring, v_slug);
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    v_document_status := 'missing_required';
    v_blocking_reason := 'missing_required_document';
  ELSIF array_length(v_rejected, 1) IS NOT NULL THEN
    v_document_status := 'rejected_required';
    v_blocking_reason := 'document_rejected';
  ELSIF array_length(v_expiry_missing, 1) IS NOT NULL THEN
    v_document_status := 'expired_required';
    v_blocking_reason := 'expiry_required_but_missing';
  ELSIF array_length(v_expired, 1) IS NOT NULL THEN
    v_document_status := 'expired_required';
    v_blocking_reason := 'document_expired';
  ELSIF array_length(v_pending, 1) IS NOT NULL THEN
    v_document_status := 'missing_required';
    v_blocking_reason := 'document_pending';
  ELSIF array_length(v_expiring, 1) IS NOT NULL THEN
    v_document_status := 'expiring_soon';
    v_blocking_reason := NULL;
  ELSE
    v_document_status := 'compliant';
    v_blocking_reason := NULL;
  END IF;

  v_approved := (v_blocking_reason IS NULL);
  v_should_open := (v_blocking_reason IS NOT NULL);

  -- Prefer the first blocking document reason when present.
  IF jsonb_array_length(v_blocking_docs) > 0 THEN
    v_block_reason_one := v_blocking_docs -> 0 ->> 'reason';
    IF v_block_reason_one IS NOT NULL THEN
      v_blocking_reason := v_block_reason_one;
    END IF;
  END IF;

  v_compliance_hash := md5(
    p_driver_id::text || '|' ||
    v_service_area_id::text || '|' ||
    v_rule_version || '|' ||
    v_document_status || '|' ||
    COALESCE(array_to_string(v_hash_parts, ';'), '')
  );

  RETURN jsonb_build_object(
    'approved', v_approved,
    'eligible', v_approved,
    'document_status', v_document_status,
    'code', CASE
      WHEN v_approved AND v_document_status = 'compliant' THEN null
      WHEN v_document_status = 'expiring_soon' THEN null
      WHEN v_blocking_reason = 'document_pending' THEN 'DOCUMENTS_PENDING_REVIEW'
      WHEN v_blocking_reason = 'missing_required_document' THEN 'DOCUMENTS_MISSING'
      WHEN v_blocking_reason = 'document_rejected' THEN 'DOCUMENTS_REJECTED'
      WHEN v_blocking_reason = 'document_expired' THEN 'DOCUMENTS_EXPIRED'
      WHEN v_blocking_reason = 'expiry_required_but_missing' THEN 'DOCUMENTS_EXPIRED'
      ELSE 'DOCUMENTS_PENDING_REVIEW'
    END,
    'blocking_reason', v_blocking_reason,
    'message', CASE
      WHEN v_approved AND v_document_status = 'compliant' THEN ''
      WHEN v_document_status = 'expiring_soon' THEN format(
        '%s document(s) expiring soon for %s',
        array_length(v_expiring, 1),
        COALESCE(v_service_area_name, 'assigned service area')
      )
      WHEN array_length(v_rejected, 1) IS NOT NULL THEN format(
        'Rejected documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_rejected, ', ')
      )
      WHEN array_length(v_expired, 1) IS NOT NULL THEN format(
        'Expired documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_expired, ', ')
      )
      WHEN array_length(v_expiry_missing, 1) IS NOT NULL THEN format(
        'Expiry date required for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_expiry_missing, ', ')
      )
      WHEN array_length(v_missing, 1) IS NOT NULL THEN format(
        'Missing documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_missing, ', ')
      )
      WHEN array_length(v_pending, 1) IS NOT NULL THEN format(
        'Documents pending review for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_pending, ', ')
      )
      ELSE 'Documents incomplete for assigned service area.'
    END,
    'service_area_id', v_service_area_id,
    'service_area_name', v_service_area_name,
    'required_documents', to_jsonb(v_required_slugs),
    'missing_documents', to_jsonb(v_missing),
    'expired_documents', to_jsonb(v_expired || v_expiry_missing),
    'expiry_missing_documents', to_jsonb(v_expiry_missing),
    'pending_documents', to_jsonb(v_pending),
    'rejected_documents', to_jsonb(v_rejected),
    'expiring_soon_documents', to_jsonb(
      CASE WHEN v_approved THEN v_expiring ELSE ARRAY[]::text[] END
    ),
    'blocking_documents', v_blocking_docs,
    'compliance_hash', v_compliance_hash,
    'rule_version', v_rule_version,
    'should_open_documents', v_should_open,
    'should_notify', false
  );
END;
$function$;

COMMENT ON FUNCTION public.get_driver_document_eligibility(uuid) IS
  'SA-rule document compliance SSOT. Blocks only active+mandatory rules; expiry only when expiry_required; display_in_driver_app is visibility-only.';

CREATE OR REPLACE FUNCTION public.check_driver_documents_approved(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((public.get_driver_document_eligibility(p_driver_id) ->> 'eligible')::boolean, false);
$function$;

-- Rebuild My Documents / Admin compliance view from service-area rules.
CREATE OR REPLACE VIEW public.driver_document_compliance_ssot AS
WITH today_london AS (
  SELECT public.driver_compliance_today_london() AS today
),
current_docs AS (
  SELECT
    d.driver_id,
    d.document_type,
    d.document_type_id,
    d.id AS document_id,
    d.status,
    d.expiry_date,
    d.file_url,
    d.updated_at,
    d.is_current,
    d.superseded_by,
    row_number() OVER (
      PARTITION BY d.driver_id, COALESCE(d.document_type_id::text, d.document_type)
      ORDER BY
        CASE WHEN COALESCE(d.is_current, true) THEN 0 ELSE 1 END,
        CASE WHEN lower(COALESCE(d.status, '')) = 'approved' THEN 0 ELSE 1 END,
        d.updated_at DESC NULLS LAST
    ) AS rn
  FROM public.documents d
),
rule_rows AS (
  SELECT
    dr.id AS driver_id,
    dt.id AS document_type_id,
    dt.slug AS document_type_key,
    dt.name AS display_name,
    COALESCE(sar.mandatory, false) AS is_required,
    COALESCE(sar.expiry_required, false) AS has_expiry,
    COALESCE(sar.display_in_driver_app, true) AS display_in_driver_app,
    COALESCE(sar.is_active, false) AS rule_active,
    sar.sort_order
  FROM public.drivers dr
  JOIN public.service_area_document_rules sar
    ON sar.service_area_id = dr.service_area_id
  JOIN public.document_types dt
    ON dt.id = sar.doc_type_id
  WHERE COALESCE(dt.is_active, true) = true
    AND (
      -- Visible list rows
      (sar.is_active = true AND COALESCE(sar.display_in_driver_app, true) = true)
      -- Or keep history for uploads against inactive/optional/hidden rules
      OR EXISTS (
        SELECT 1
        FROM current_docs cd
        WHERE cd.driver_id = dr.id
          AND cd.rn = 1
          AND (
            cd.document_type_id = dt.id
            OR cd.document_type = dt.slug
          )
      )
    )
)
SELECT
  rr.driver_id,
  rr.document_type_id,
  rr.document_type_key,
  rr.display_name,
  rr.is_required,
  rr.has_expiry,
  cd.document_id,
  cd.status AS approval_status,
  cd.expiry_date,
  cd.file_url,
  cd.updated_at AS last_updated_at,
  cd.superseded_by AS replacement_document_id,
  COALESCE(cd.is_current, false) AS is_current,
  (cd.document_id IS NOT NULL AND COALESCE(cd.is_current, true) = false) AS is_superseded,
  CASE
    WHEN cd.document_id IS NULL THEN 'missing'
    WHEN lower(COALESCE(cd.status, '')) IN ('rejected', 'declined') THEN 'rejected'
    WHEN lower(COALESCE(cd.status, '')) IN ('pending', 'uploaded', 'submitted', 'under_review') THEN 'pending'
    -- Expiry only when the SA rule requires it.
    WHEN rr.has_expiry
         AND lower(COALESCE(cd.status, '')) = 'approved'
         AND cd.expiry_date IS NULL THEN 'expired'
    WHEN rr.has_expiry
         AND cd.expiry_date IS NOT NULL
         AND cd.expiry_date < (SELECT today FROM today_london) THEN 'expired'
    WHEN rr.has_expiry
         AND cd.expiry_date IS NOT NULL
         AND lower(COALESCE(cd.status, '')) = 'approved'
         AND cd.expiry_date <= ((SELECT today FROM today_london) + 7) THEN 'expiring_soon'
    WHEN lower(COALESCE(cd.status, '')) = 'approved' THEN 'approved_valid'
    ELSE 'pending'
  END AS expiry_status,
  CASE
    WHEN cd.expiry_date IS NULL THEN NULL::integer
    ELSE cd.expiry_date - (SELECT today FROM today_london)
  END AS days_until_expiry,
  (
    rr.rule_active
    AND rr.is_required
    AND (
      cd.document_id IS NULL
      OR lower(COALESCE(cd.status, '')) IN ('rejected', 'declined')
      OR lower(COALESCE(cd.status, '')) IS DISTINCT FROM 'approved'
      OR (
        rr.has_expiry
        AND (
          cd.expiry_date IS NULL
          OR cd.expiry_date < (SELECT today FROM today_london)
        )
      )
    )
  ) AS blocks_online
FROM rule_rows rr
LEFT JOIN current_docs cd
  ON cd.driver_id = rr.driver_id
 AND cd.rn = 1
 AND (
   cd.document_type_id = rr.document_type_id
   OR cd.document_type = rr.document_type_key
 );

COMMENT ON VIEW public.driver_document_compliance_ssot IS
  'Driver document compliance rows from service_area_document_rules. blocks_online uses active+mandatory+expiry_required only.';

-- Refresh cached documents_approved for all drivers so Admin rule changes take effect.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id FROM public.drivers WHERE deleted_at IS NULL
  LOOP
    BEGIN
      PERFORM public.recalculate_driver_documents_approved(r.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'recalculate_driver_documents_approved failed for %: %', r.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

COMMIT;
