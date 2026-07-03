-- P0 follow-up:
-- 1) Rules are "configured" when any service_area_document_rules rows exist
--    (disabled rules mean not required — do not block go-online).
-- 2) Seed Milton Keynes (and any SA with zero rule rows) from global document_types
--    so MK keeps working without a global runtime fallback.

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
  v_required_slugs text[];
  v_missing text[] := ARRAY[]::text[];
  v_expired text[] := ARRAY[]::text[];
  v_pending text[] := ARRAY[]::text[];
  v_rejected text[] := ARRAY[]::text[];
  v_slug text;
  v_status text;
  v_expiry date;
  v_expiry_required boolean;
  v_approved_count integer := 0;
  v_required_count integer := 0;
BEGIN
  v_today_london := public.driver_compliance_today_london();

  SELECT d.service_area_id, sa.name
  INTO v_service_area_id, v_service_area_name
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = d.service_area_id
  WHERE d.id = p_driver_id;

  IF v_service_area_id IS NULL THEN
    RETURN jsonb_build_object(
      'approved', false,
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'message', 'Driver has no assigned service area. Assign a service area before going online.',
      'service_area_id', null,
      'service_area_name', null,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb
    );
  END IF;

  -- Configured = any rule rows exist for this SA (even if all currently disabled).
  SELECT EXISTS(
    SELECT 1
    FROM public.service_area_document_rules sar
    WHERE sar.service_area_id = v_service_area_id
  ) INTO v_rules_configured;

  IF NOT v_rules_configured THEN
    RETURN jsonb_build_object(
      'approved', false,
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
      'rejected_documents', '[]'::jsonb
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
    v_required_slugs := array_append(COALESCE(v_required_slugs, ARRAY[]::text[]), v_slug);

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
      CONTINUE;
    END IF;

    v_status := lower(trim(v_status));

    IF v_status IN ('rejected', 'declined') THEN
      v_rejected := array_append(v_rejected, v_slug);
      CONTINUE;
    END IF;

    IF v_status IN ('resubmission_required', 'resubmit_required', 'requires_resubmission') THEN
      v_rejected := array_append(v_rejected, v_slug);
      CONTINUE;
    END IF;

    IF v_expiry_required AND (v_expiry IS NULL OR v_expiry < v_today_london) THEN
      v_expired := array_append(v_expired, v_slug);
      CONTINUE;
    END IF;

    IF v_status = 'approved' THEN
      v_approved_count := v_approved_count + 1;
      CONTINUE;
    END IF;

    v_pending := array_append(v_pending, v_slug);
  END LOOP;

  IF v_required_count = 0 THEN
    RETURN jsonb_build_object(
      'approved', true,
      'code', null,
      'message', '',
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb
    );
  END IF;

  IF array_length(v_rejected, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'approved', false,
      'code', 'DOCUMENTS_REJECTED',
      'message', format(
        'Rejected documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_rejected, ', ')
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', to_jsonb(v_required_slugs),
      'missing_documents', to_jsonb(v_missing),
      'expired_documents', to_jsonb(v_expired),
      'pending_documents', to_jsonb(v_pending),
      'rejected_documents', to_jsonb(v_rejected)
    );
  END IF;

  IF array_length(v_expired, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'approved', false,
      'code', 'DOCUMENTS_EXPIRED',
      'message', format(
        'Expired documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_expired, ', ')
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', to_jsonb(v_required_slugs),
      'missing_documents', to_jsonb(v_missing),
      'expired_documents', to_jsonb(v_expired),
      'pending_documents', to_jsonb(v_pending),
      'rejected_documents', to_jsonb(v_rejected)
    );
  END IF;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'approved', false,
      'code', 'DOCUMENTS_MISSING',
      'message', format(
        'Missing documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_missing, ', ')
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', to_jsonb(v_required_slugs),
      'missing_documents', to_jsonb(v_missing),
      'expired_documents', to_jsonb(v_expired),
      'pending_documents', to_jsonb(v_pending),
      'rejected_documents', to_jsonb(v_rejected)
    );
  END IF;

  IF array_length(v_pending, 1) IS NOT NULL THEN
    RETURN jsonb_build_object(
      'approved', false,
      'code', 'DOCUMENTS_PENDING_REVIEW',
      'message', format(
        'Documents pending review for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_pending, ', ')
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', to_jsonb(v_required_slugs),
      'missing_documents', to_jsonb(v_missing),
      'expired_documents', to_jsonb(v_expired),
      'pending_documents', to_jsonb(v_pending),
      'rejected_documents', to_jsonb(v_rejected)
    );
  END IF;

  RETURN jsonb_build_object(
    'approved', v_approved_count >= v_required_count,
    'code', CASE WHEN v_approved_count >= v_required_count THEN null ELSE 'DOCUMENTS_PENDING_REVIEW' END,
    'message', CASE WHEN v_approved_count >= v_required_count THEN '' ELSE 'Documents incomplete for assigned service area.' END,
    'service_area_id', v_service_area_id,
    'service_area_name', v_service_area_name,
    'required_documents', to_jsonb(COALESCE(v_required_slugs, ARRAY[]::text[])),
    'missing_documents', to_jsonb(v_missing),
    'expired_documents', to_jsonb(v_expired),
    'pending_documents', to_jsonb(v_pending),
    'rejected_documents', to_jsonb(v_rejected)
  );
END;
$function$;

-- Seed SA rules only where none exist (MK historically relied on global is_required).
INSERT INTO public.service_area_document_rules (
  service_area_id,
  doc_type_id,
  display_in_driver_app,
  mandatory,
  expiry_required,
  sort_order,
  is_active
)
SELECT
  sa.id,
  dt.id,
  COALESCE(dt.show_in_driver_app, true),
  COALESCE(dt.is_required, true),
  COALESCE(dt.has_expiry, true),
  COALESCE(dt.display_order, 100),
  true
FROM public.service_areas sa
CROSS JOIN public.document_types dt
WHERE dt.is_active = true
  AND COALESCE(dt.show_in_driver_app, true) = true
  AND NOT EXISTS (
    SELECT 1
    FROM public.service_area_document_rules sar
    WHERE sar.service_area_id = sa.id
  )
ON CONFLICT (service_area_id, doc_type_id) DO NOTHING;

-- Recalc after seed.
UPDATE public.drivers d
SET
  documents_approved = public.check_driver_documents_approved(d.id),
  is_online = CASE
    WHEN public.check_driver_documents_approved(d.id) THEN d.is_online
    ELSE false
  END,
  updated_at = now();
