-- P0: Full document compliance payload for driver app notification/navigation SSOT.
-- Assigned service area only. No global/MK fallback.
-- should_notify is always false when compliant (client celebrates only on in-session regression→fix).

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
  v_pending text[] := ARRAY[]::text[];
  v_rejected text[] := ARRAY[]::text[];
  v_expiring text[] := ARRAY[]::text[];
  v_hash_parts text[] := ARRAY[]::text[];
  v_slug text;
  v_status text;
  v_expiry date;
  v_expiry_required boolean;
  v_approved_count integer := 0;
  v_required_count integer := 0;
  v_document_status text;
  v_compliance_hash text;
  v_rule_version text;
  v_should_open boolean;
  v_approved boolean;
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
      'document_status', 'service_area_not_assigned',
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'message', 'Driver has no assigned service area. Assign a service area before going online.',
      'service_area_id', null,
      'service_area_name', null,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb,
      'expiring_soon_documents', '[]'::jsonb,
      'compliance_hash', v_compliance_hash,
      'rule_version', 'none',
      'should_open_documents', true,
      'should_notify', false
    );
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.service_area_document_rules sar
    WHERE sar.service_area_id = v_service_area_id
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
      'document_status', 'rules_not_configured',
      'code', 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED',
      'message', format(
        'Document rules are not configured for service area %s.',
        COALESCE(v_service_area_name, v_service_area_id::text)
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb,
      'expiring_soon_documents', '[]'::jsonb,
      'compliance_hash', v_compliance_hash,
      'rule_version', v_rule_version,
      'should_open_documents', true,
      'should_notify', false
    );
  END IF;

  FOR v_slug, v_expiry_required IN
    SELECT dt.slug, COALESCE(sar.expiry_required, true)
    FROM public.service_area_document_rules sar
    JOIN public.document_types dt ON dt.id = sar.doc_type_id
    WHERE sar.service_area_id = v_service_area_id
      AND sar.is_active = true
      AND COALESCE(sar.display_in_driver_app, true) = true
      AND sar.mandatory = true
      AND dt.is_active = true
    ORDER BY sar.sort_order NULLS LAST, dt.display_order NULLS LAST, dt.name
  LOOP
    v_required_count := v_required_count + 1;
    v_required_slugs := array_append(v_required_slugs, v_slug);

    SELECT d.status, d.expiry_date
    INTO v_status, v_expiry
    FROM public.documents d
    WHERE d.driver_id = p_driver_id
      AND d.document_type = v_slug
    ORDER BY
      CASE WHEN d.status = 'approved' THEN 0 ELSE 1 END,
      d.updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_status IS NULL THEN
      v_missing := array_append(v_missing, v_slug);
      v_hash_parts := array_append(v_hash_parts, v_slug || ':missing:');
      CONTINUE;
    END IF;

    v_status := lower(trim(v_status));
    v_hash_parts := array_append(
      v_hash_parts,
      v_slug || ':' || v_status || ':' || COALESCE(v_expiry::text, '')
    );

    IF v_status IN ('rejected', 'declined', 'resubmission_required', 'resubmit_required', 'requires_resubmission') THEN
      v_rejected := array_append(v_rejected, v_slug);
      CONTINUE;
    END IF;

    IF v_expiry_required AND (v_expiry IS NULL OR v_expiry < v_today_london) THEN
      v_expired := array_append(v_expired, v_slug);
      CONTINUE;
    END IF;

    IF v_status = 'approved' THEN
      v_approved_count := v_approved_count + 1;
      IF v_expiry_required
         AND v_expiry IS NOT NULL
         AND v_expiry >= v_today_london
         AND v_expiry <= (v_today_london + v_warn_days)
      THEN
        v_expiring := array_append(v_expiring, v_slug);
      END IF;
      CONTINUE;
    END IF;

    v_pending := array_append(v_pending, v_slug);
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    v_document_status := 'missing_required';
  ELSIF array_length(v_rejected, 1) IS NOT NULL THEN
    v_document_status := 'rejected_required';
  ELSIF array_length(v_expired, 1) IS NOT NULL THEN
    v_document_status := 'expired_required';
  ELSIF array_length(v_expiring, 1) IS NOT NULL THEN
    v_document_status := 'expiring_soon';
  ELSE
    v_document_status := 'compliant';
  END IF;

  v_approved := (
    v_document_status IN ('compliant', 'expiring_soon')
    AND array_length(v_pending, 1) IS NULL
  );

  -- Pending review still blocks go-online.
  IF array_length(v_pending, 1) IS NOT NULL THEN
    v_approved := false;
    IF v_document_status IN ('compliant', 'expiring_soon') THEN
      v_document_status := 'missing_required';
    END IF;
  END IF;

  v_should_open := v_document_status IN (
    'missing_required',
    'rejected_required',
    'expired_required',
    'service_area_not_assigned',
    'rules_not_configured'
  );

  v_compliance_hash := md5(
    p_driver_id::text || '|' ||
    v_service_area_id::text || '|' ||
    v_rule_version || '|' ||
    v_document_status || '|' ||
    COALESCE(array_to_string(v_hash_parts, ';'), '')
  );

  RETURN jsonb_build_object(
    'approved', v_approved,
    'document_status', v_document_status,
    'code', CASE
      WHEN v_approved AND v_document_status = 'compliant' THEN null
      WHEN v_document_status = 'expiring_soon' THEN null
      WHEN v_document_status = 'missing_required' AND array_length(v_pending, 1) IS NOT NULL THEN 'DOCUMENTS_PENDING_REVIEW'
      WHEN v_document_status = 'missing_required' THEN 'DOCUMENTS_MISSING'
      WHEN v_document_status = 'rejected_required' THEN 'DOCUMENTS_REJECTED'
      WHEN v_document_status = 'expired_required' THEN 'DOCUMENTS_EXPIRED'
      ELSE 'DOCUMENTS_PENDING_REVIEW'
    END,
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
    'expired_documents', to_jsonb(v_expired),
    'pending_documents', to_jsonb(v_pending),
    'rejected_documents', to_jsonb(v_rejected),
    'expiring_soon_documents', to_jsonb(
      CASE WHEN v_approved THEN v_expiring ELSE ARRAY[]::text[] END
    ),
    'compliance_hash', v_compliance_hash,
    'rule_version', v_rule_version,
    'should_open_documents', v_should_open,
    -- Always false when compliant: client may celebrate only on in-session regression→fix.
    'should_notify', false
  );
END;
$function$;

COMMENT ON FUNCTION public.get_driver_document_eligibility(uuid) IS
  'Assigned-SA document compliance payload: document_status, compliance_hash, should_open_documents, should_notify. No global/MK fallback.';

CREATE OR REPLACE FUNCTION public.check_driver_documents_approved(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE((public.get_driver_document_eligibility(p_driver_id) ->> 'approved')::boolean, false);
$function$;
