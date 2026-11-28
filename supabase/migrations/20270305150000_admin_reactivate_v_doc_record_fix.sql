-- Fix admin_reactivate_driver_vehicle FOR-loop variable type.
-- v_doc was declared jsonb while the loop selected a row with column j; Postgres
-- then raised 42P01 missing FROM-clause entry for table "v_doc".
-- Also apply the same RECORD fix to admin_set_trip_active_vehicle's identical loop.
-- Do not apply to production until authenticated verification. Contracts verified:false.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_reactivate_driver_vehicle(
  p_vehicle_id uuid,
  p_release_temporary_vehicle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_temp public.vehicles%ROWTYPE;
  v_doc record;
  v_gaps jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (
       public.has_role(v_uid, 'admin'::app_role)
       OR public.staff_has_any_page_access(ARRAY['vehicles','drivers'])
     )
  THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_vehicle.driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_DRIVER');
  END IF;

  FOR v_doc IN
    SELECT jsonb_build_object('slug', s.slug, 'state',
      CASE
        WHEN d.id IS NULL THEN 'missing'
        WHEN lower(COALESCE(d.status,'')) = 'approved'
             AND (d.expiry_date IS NULL OR d.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date)
          THEN 'approved'
        WHEN lower(COALESCE(d.status,'')) = 'pending' THEN 'pending'
        WHEN lower(COALESCE(d.status,'')) = 'rejected' THEN 'rejected'
        WHEN lower(COALESCE(d.status,'')) = 'expired' THEN 'expired'
        WHEN d.expiry_date IS NOT NULL AND d.expiry_date < (now() AT TIME ZONE 'Europe/London')::date THEN 'expired'
        ELSE 'missing'
      END,
      'document_id', d.id
    ) AS j
    FROM unnest(public.vehicle_change_document_slugs()) AS s(slug)
    LEFT JOIN LATERAL (
      SELECT doc.*
        FROM public.documents doc
       WHERE doc.driver_id = v_vehicle.driver_id
         AND doc.document_type = s.slug
         AND COALESCE(doc.is_current, true) = true
         AND doc.vehicle_id = v_vehicle.id
       ORDER BY doc.created_at DESC
       LIMIT 1
    ) d ON true
    WHERE EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          COALESCE(
            (public.get_driver_document_eligibility_internal(v_vehicle.driver_id)->'required_documents'),
            '[]'::jsonb
          )
        ) req WHERE req = s.slug
    )
  LOOP
    IF (v_doc.j->>'state') <> 'approved' THEN
      v_gaps := v_gaps || jsonb_build_array(v_doc.j);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_gaps) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCUMENTS_INVALID', 'gaps', v_gaps);
  END IF;

  UPDATE public.vehicles
     SET is_trip_active = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM v_vehicle.id
     AND is_trip_active = true;

  UPDATE public.vehicles
     SET operational_status = 'active',
         approval_status = 'approved',
         is_trip_active = true,
         is_primary = true,
         suspended_reason = NULL,
         updated_at = now()
   WHERE id = v_vehicle.id;

  UPDATE public.vehicles
     SET is_primary = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM v_vehicle.id
     AND is_primary = true;

  IF p_release_temporary_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_temp FROM public.vehicles WHERE id = p_release_temporary_vehicle_id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.vehicle_driver_assignments
         SET ended_at = now(),
             ended_reason = 'owner_vehicle_reactivated',
             updated_at = now()
       WHERE vehicle_id = v_temp.id
         AND driver_id = v_vehicle.driver_id
         AND ended_at IS NULL;

      UPDATE public.vehicles
         SET driver_id = CASE WHEN fleet_shared THEN NULL ELSE driver_id END,
             is_primary = false,
             is_trip_active = false,
             operational_status = CASE WHEN fleet_shared THEN 'available_in_fleet' ELSE operational_status END,
             updated_at = now()
       WHERE id = v_temp.id;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_reactivated', v_uid, v_vehicle.driver_id,
          jsonb_build_object(
            'vehicle_id', v_vehicle.id,
            'released_temporary_vehicle_id', p_release_temporary_vehicle_id,
            'reused_documents', true
          ));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id);
END;
$$;

DO $$
DECLARE
  v_src text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.admin_set_trip_active_vehicle(uuid,text)'::regprocedure)
    INTO v_src;
  IF v_src IS NULL THEN
    RAISE NOTICE 'admin_set_trip_active_vehicle missing — skip RECORD patch';
    RETURN;
  END IF;
  IF position('v_doc jsonb' in v_src) = 0 THEN
    RAISE NOTICE 'admin_set_trip_active_vehicle already patched';
    RETURN;
  END IF;
  v_new := replace(v_src, 'v_doc jsonb;', 'v_doc record;');
  EXECUTE v_new;
END $$;

COMMIT;
