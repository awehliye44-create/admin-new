-- Rollback Phase 3 final security migration ONLY.
-- Preserves Phase 1/2 financial protections and Phase 3 hold_reason column/trigger
-- from 20270213120000. Restores admin_page_mutate without protected-field refusal
-- and admin_assign_scheduled_driver to pre-action-RBAC body (payment-first atomicity).

BEGIN;

-- Drop publication_exhausted from CHECK (keep other Phase 3 reasons).
ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_scheduled_hold_reason_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_scheduled_hold_reason_check
  CHECK (
    scheduled_hold_reason IS NULL
    OR scheduled_hold_reason = ANY (ARRAY[
      'publication_pending',
      'publication_retry',
      'airport_pricing',
      'payment_gate',
      'manual_trip',
      'admin_exceptional',
      'unknown_historical'
    ]::text[])
  );

-- Revert exhausted stamps to publication_retry so CHECK accepts.
UPDATE public.trips
SET scheduled_hold_reason = 'publication_retry',
    updated_at = now()
WHERE scheduled_hold_reason = 'publication_exhausted';

DROP FUNCTION IF EXISTS public._admin_trips_protected_mutate_columns();

-- Restore admin_page_mutate from 20261231183000 (no protected-field block).
CREATE OR REPLACE FUNCTION public.admin_page_mutate(
  p_page_slug text,
  p_table text,
  p_op text,
  p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_table text := lower(btrim(p_table));
  v_page text := lower(btrim(p_page_slug));
  v_op text := lower(btrim(p_op));
  v_pages text[];
  v_allowed text[];
  v_select_cols text[];
  v_patch jsonb := COALESCE(p_args->'patch', '{}'::jsonb);
  v_id uuid;
  v_ids uuid[];
  v_key text;
  v_set_parts text[] := ARRAY[]::text[];
  v_col_list text[] := ARRAY[]::text[];
  v_val_list text[] := ARRAY[]::text[];
  v_where text := 'TRUE';
  v_sql text;
  v_row jsonb;
  v_rows jsonb;
  v_count int := 0;
BEGIN
  PERFORM public.admin_assert_staff_page(v_page);
  PERFORM set_config('onecab.admin_page_mutate', '1', true);
  v_pages := public._admin_page_mutate_pages(v_table, v_op);
  IF NOT (v_page = ANY (v_pages)) THEN
    RAISE EXCEPTION 'not authorized: page % cannot % %', v_page, v_op, v_table
      USING ERRCODE = '42501';
  END IF;
  v_allowed := public._admin_page_mutate_columns(v_table);
  IF cardinality(v_allowed) = 0 THEN
    RAISE EXCEPTION 'not authorized: mutate not allowed for %', v_table USING ERRCODE = '42501';
  END IF;
  IF v_op = 'update' THEN
    v_id := NULLIF(p_args->>'id', '')::uuid;
    v_select_cols := public._admin_page_columns(v_table);
    IF v_id IS NOT NULL THEN
      v_where := format('id = %L', v_id);
    END IF;
    IF p_args ? 'filters' OR p_args ? 'or_groups' OR p_args ? 'and_or_groups' THEN
      v_where := '(' || v_where || ' AND ' ||
        public._admin_page_build_where(v_table, COALESCE(p_args, '{}'::jsonb), v_select_cols) ||
        ')';
    END IF;
    IF v_id IS NULL AND v_where = 'TRUE' THEN
      RAISE EXCEPTION 'id or filters required for update';
    END IF;
    FOR v_key IN SELECT key FROM jsonb_each(v_patch) LOOP
      IF lower(v_key) = ANY (v_allowed) THEN
        v_set_parts := array_append(
          v_set_parts,
          format('%I = %s', lower(v_key), public._admin_page_quote_json_scalar(v_patch->v_key))
        );
      END IF;
    END LOOP;
    IF cardinality(v_set_parts) = 0 THEN
      RAISE EXCEPTION 'no allowed patch fields';
    END IF;
    v_sql := format(
      'WITH updated AS (UPDATE public.%I SET %s WHERE %s RETURNING *) SELECT COALESCE(jsonb_agg(to_jsonb(u)), ''[]''::jsonb) FROM updated u',
      v_table,
      array_to_string(v_set_parts, ', '),
      v_where
    );
    EXECUTE v_sql INTO v_rows;
    v_row := CASE WHEN jsonb_array_length(COALESCE(v_rows, '[]'::jsonb)) > 0
      THEN v_rows->0 ELSE NULL END;
    RETURN jsonb_build_object('row', v_row, 'rows', COALESCE(v_rows, '[]'::jsonb));
  ELSIF v_op = 'insert' THEN
    IF v_table NOT IN (
      'drivers','trips','driver_service_areas','fare_pricing_settings',
      'corporate_fare_rules','document_types','service_area_document_rules',
      'stop_waiting_settings','dispatch_settings','service_area_cancellation_fees',
      'service_area_vehicle_pricing'
    ) THEN
      RAISE EXCEPTION 'not authorized: insert not allowed for % via this RPC', v_table
        USING ERRCODE = '42501';
    END IF;
    FOR v_key IN SELECT key FROM jsonb_each(v_patch) LOOP
      IF lower(v_key) = ANY (v_allowed) THEN
        v_col_list := array_append(v_col_list, lower(v_key));
        v_val_list := array_append(
          v_val_list,
          public._admin_page_quote_json_scalar(v_patch->v_key)
        );
      END IF;
    END LOOP;
    IF cardinality(v_col_list) = 0 THEN
      RAISE EXCEPTION 'no allowed insert fields';
    END IF;
    v_sql := format(
      'INSERT INTO public.%I (%s) VALUES (%s) RETURNING to_jsonb(%I.*)',
      v_table,
      array_to_string(ARRAY(SELECT format('%I', c) FROM unnest(v_col_list) AS c), ', '),
      array_to_string(v_val_list, ', '),
      v_table
    );
    EXECUTE v_sql INTO v_row;
    RETURN jsonb_build_object('row', v_row);
  ELSIF v_op = 'delete' THEN
    IF v_table NOT IN (
      'documents','driver_service_areas','corporate_fare_rules','document_types'
    ) THEN
      RAISE EXCEPTION 'not authorized: delete not allowed for % via this RPC', v_table
        USING ERRCODE = '42501';
    END IF;
    v_select_cols := public._admin_page_columns(v_table);
    SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_args->'ids', '[]'::jsonb))::uuid)
      INTO v_ids;
    IF v_ids IS NOT NULL AND cardinality(v_ids) > 0 THEN
      v_where := format('id = ANY (%L::uuid[])', v_ids);
    ELSIF p_args ? 'filters' OR p_args ? 'or_groups' OR p_args ? 'and_or_groups' THEN
      v_where := public._admin_page_build_where(v_table, COALESCE(p_args, '{}'::jsonb), v_select_cols);
    ELSE
      RAISE EXCEPTION 'ids or filters required for delete';
    END IF;
    v_sql := format('DELETE FROM public.%I WHERE %s', v_table, v_where);
    EXECUTE v_sql;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN jsonb_build_object('deleted', v_count);
  ELSE
    RAISE EXCEPTION 'not authorized: op %', v_op USING ERRCODE = '42501';
  END IF;
END;
$fn$;

-- Restore assign RPC from 20270201120200 (is_admin / service_role only).
CREATE OR REPLACE FUNCTION public.admin_assign_scheduled_driver(
  p_trip_id uuid,
  p_driver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_trip RECORD;
  v_now timestamptz := now();
BEGIN
  IF NOT (
    public.is_admin()
    OR current_setting('request.jwt.claim.role', true) = 'service_role'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Admin access required');
  END IF;

  IF p_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF v_trip.completed_at IS NOT NULL OR v_trip.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_TERMINAL');
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_LIVE_ASSIGNED');
  END IF;

  IF COALESCE(v_trip.scheduled_status::text, '') NOT IN (
    'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_STATE',
      'scheduled_status', v_trip.scheduled_status
    );
  END IF;

  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_GATE_NOT_SATISFIED',
      'message', SQLERRM
    );
  END;

  UPDATE public.trips
     SET confirmed_driver_id = p_driver_id,
         scheduled_status = 'driver_assigned',
         scheduled_accepted_at = v_now,
         status = 'scheduled',
         driver_id = NULL,
         pending_release_kind = NULL,
         pending_release_at = NULL,
         pending_release_driver_id = NULL,
         updated_at = v_now
   WHERE id = p_trip_id
     AND driver_id IS NULL
     AND completed_at IS NULL
     AND scheduled_status::text IN (
       'admin_held', 'scheduled', 'broadcasting', 'pending', 'driver_assigned'
     );

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'CAS_MISMATCH');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'confirmed_driver_id', p_driver_id
  );
END;
$fn$;

COMMIT;
