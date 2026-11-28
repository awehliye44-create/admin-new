-- Admin Vehicles list: page-gated change-request listing + per-vehicle document
-- compliance summaries (SA rules ∩ vehicle_change_document_slugs, docs for THAT
-- vehicle_id only). Do not apply to production project thazislrdkjpvvghtvzo until
-- authenticated non-prod E2E passes. Lifecycle RPC contracts remain verified:false.

BEGIN;

-- ---------------------------------------------------------------------------
-- List vehicle change requests for Admin Vehicles page (page RBAC).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_vehicle_change_requests(
  p_limit integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 200), 500));
  v_rows jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.created_at DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        r.id,
        r.driver_id,
        r.vehicle_id,
        r.requested_make,
        r.requested_model,
        r.requested_year,
        r.requested_color,
        r.requested_license_plate,
        r.status,
        r.admin_notes,
        r.rejection_reason,
        r.reviewed_at,
        r.reviewed_by,
        r.cancelled_at,
        r.created_at,
        r.updated_at,
        jsonb_build_object(
          'first_name', d.first_name,
          'last_name', d.last_name,
          'driver_code', d.driver_code
        ) AS driver,
        CASE
          WHEN v.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'make', v.make,
            'model', v.model,
            'year', v.year,
            'color', v.color,
            'license_plate', v.license_plate
          )
        END AS vehicle
      FROM public.vehicle_change_requests r
      LEFT JOIN public.drivers d ON d.id = r.driver_id
      LEFT JOIN public.vehicles v ON v.id = r.vehicle_id
      ORDER BY r.created_at DESC
      LIMIT v_limit
    ) q;

  RETURN jsonb_build_object('ok', true, 'requests', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_vehicle_change_requests(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_vehicle_change_requests(integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per-vehicle document compliance summary.
-- Required types = SA eligibility required_documents ∩ vehicle_change_document_slugs.
-- Status from current documents linked to THAT vehicle_id only (never driver-level
-- or another vehicle's rows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_vehicle_document_compliance_summaries(
  p_vehicle_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb := '[]'::jsonb;
  v_vehicle public.vehicles%ROWTYPE;
  v_elig jsonb;
  v_required text[];
  v_slug text;
  v_status text;
  v_expiry date;
  v_missing integer;
  v_pending integer;
  v_rejected integer;
  v_expired integer;
  v_approved integer;
  v_total integer;
  v_ids uuid[];
  v_found boolean;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles', 'drivers', 'documents'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_vehicle_ids IS NULL OR cardinality(p_vehicle_ids) = 0 THEN
    SELECT coalesce(array_agg(v.id ORDER BY v.created_at DESC), ARRAY[]::uuid[])
      INTO v_ids
      FROM (
        SELECT id, created_at FROM public.vehicles ORDER BY created_at DESC LIMIT 500
      ) v;
  ELSE
    v_ids := p_vehicle_ids;
  END IF;

  FOR v_vehicle IN
    SELECT * FROM public.vehicles v WHERE v.id = ANY (v_ids)
  LOOP
    v_missing := 0;
    v_pending := 0;
    v_rejected := 0;
    v_expired := 0;
    v_approved := 0;
    v_required := ARRAY[]::text[];

    IF v_vehicle.driver_id IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', false,
        'summary', 'n_a',
        'label', 'No driver',
        'required_count', 0,
        'missing', 0,
        'pending', 0,
        'rejected', 0,
        'expired', 0,
        'approved', 0
      ));
      CONTINUE;
    END IF;

    v_elig := public.get_driver_document_eligibility_internal(v_vehicle.driver_id);
    IF v_elig IS NULL
       OR v_elig->>'code' IN (
         'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
         'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED'
       )
    THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', false,
        'summary', 'rules_unavailable',
        'label', 'Rules unavailable',
        'required_count', 0,
        'missing', 0,
        'pending', 0,
        'rejected', 0,
        'expired', 0,
        'approved', 0
      ));
      CONTINUE;
    END IF;

    SELECT coalesce(array_agg(s.slug ORDER BY s.slug), ARRAY[]::text[])
      INTO v_required
      FROM unnest(public.vehicle_change_document_slugs()) AS s(slug)
     WHERE EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(
           COALESCE(v_elig->'required_documents', '[]'::jsonb)
         ) req
        WHERE req = s.slug
     );

    v_total := coalesce(cardinality(v_required), 0);

    FOREACH v_slug IN ARRAY coalesce(v_required, ARRAY[]::text[])
    LOOP
      v_status := NULL;
      v_expiry := NULL;
      v_found := false;

      SELECT d.status, d.expiry_date
        INTO v_status, v_expiry
        FROM public.documents d
       WHERE d.driver_id = v_vehicle.driver_id
         AND d.document_type = v_slug
         AND d.vehicle_id = v_vehicle.id
         AND coalesce(d.is_current, true) = true
       ORDER BY d.created_at DESC
       LIMIT 1;

      v_found := FOUND;

      IF NOT v_found OR v_status IS NULL THEN
        v_missing := v_missing + 1;
      ELSIF lower(v_status) = 'rejected' THEN
        v_rejected := v_rejected + 1;
      ELSIF lower(v_status) = 'expired'
            OR (v_expiry IS NOT NULL AND v_expiry < CURRENT_DATE) THEN
        v_expired := v_expired + 1;
      ELSIF lower(v_status) = 'pending' THEN
        v_pending := v_pending + 1;
      ELSIF lower(v_status) = 'approved' THEN
        v_approved := v_approved + 1;
      ELSE
        v_missing := v_missing + 1;
      END IF;
    END LOOP;

    IF v_total = 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', true,
        'summary', 'none_required',
        'label', 'No vehicle docs required',
        'required_count', 0,
        'missing', 0,
        'pending', 0,
        'rejected', 0,
        'expired', 0,
        'approved', 0
      ));
    ELSIF v_rejected > 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', true,
        'summary', 'action_needed',
        'label', format('Action needed (%s rejected)', v_rejected),
        'required_count', v_total,
        'missing', v_missing,
        'pending', v_pending,
        'rejected', v_rejected,
        'expired', v_expired,
        'approved', v_approved
      ));
    ELSIF v_expired > 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', true,
        'summary', 'expired',
        'label', format('Expired (%s)', v_expired),
        'required_count', v_total,
        'missing', v_missing,
        'pending', v_pending,
        'rejected', v_rejected,
        'expired', v_expired,
        'approved', v_approved
      ));
    ELSIF v_missing > 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', true,
        'summary', 'missing',
        'label', format('Missing (%s)', v_missing),
        'required_count', v_total,
        'missing', v_missing,
        'pending', v_pending,
        'rejected', v_rejected,
        'expired', v_expired,
        'approved', v_approved
      ));
    ELSIF v_pending > 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', true,
        'summary', 'pending_review',
        'label', format('Pending review (%s)', v_pending),
        'required_count', v_total,
        'missing', v_missing,
        'pending', v_pending,
        'rejected', v_rejected,
        'expired', v_expired,
        'approved', v_approved
      ));
    ELSE
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'vehicle_id', v_vehicle.id,
        'rules_available', true,
        'summary', 'complete',
        'label', format('Complete (%s/%s)', v_approved, v_total),
        'required_count', v_total,
        'missing', 0,
        'pending', 0,
        'rejected', 0,
        'expired', 0,
        'approved', v_approved
      ));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'summaries', v_out);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_vehicle_document_compliance_summaries(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_vehicle_document_compliance_summaries(uuid[]) TO authenticated, service_role;

COMMIT;
