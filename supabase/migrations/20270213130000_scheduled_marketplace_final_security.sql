-- Phase 3 final security readiness (DO NOT apply until production deploy approval).
-- 1) publication_exhausted hold reason
-- 2) admin_page_mutate cannot patch protected scheduled marketplace fields
-- 3) admin_assign_scheduled_driver requires scheduled_rides.assign (Owner bypass via staff_has_action)
-- No mass-grant of scheduled_rides.* action permissions.

BEGIN;

-- ── 1) Exhaustion hold reason (additive) ─────────────────────────────────────
ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_scheduled_hold_reason_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_scheduled_hold_reason_check
  CHECK (
    scheduled_hold_reason IS NULL
    OR scheduled_hold_reason = ANY (ARRAY[
      'publication_pending',
      'publication_retry',
      'publication_exhausted',
      'airport_pricing',
      'payment_gate',
      'manual_trip',
      'admin_exceptional',
      'unknown_historical'
    ]::text[])
  );

COMMENT ON COLUMN public.trips.scheduled_hold_reason IS
  'Phase 3 authoritative hold: publication_pending|publication_retry|publication_exhausted|airport_pricing|payment_gate|manual_trip|admin_exceptional|unknown_historical. Auto-publish only pending/retry.';

-- ── 2) Protected trips columns — blocked on admin_page_mutate UPDATE ─────────
CREATE OR REPLACE FUNCTION public._admin_trips_protected_mutate_columns()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ARRAY[
    'scheduled_status',
    'scheduled_broadcast_at',
    'broadcast_enabled',
    'scheduled_hold_reason',
    'scheduled_publish_attempts',
    'pending_release_kind',
    'pending_release_at',
    'pending_release_driver_id',
    'confirmed_driver_id',
    'driver_id',
    'dispatch_mode',
    'dispatch_status',
    'status',
    'scheduled_convert_at',
    'scheduled_accepted_at',
    'current_broadcast_round',
    'searching_expires_at'
  ]::text[];
$fn$;

COMMENT ON FUNCTION public._admin_trips_protected_mutate_columns() IS
  'Scheduled marketplace / dispatch fields that staff cannot change via admin_page_mutate. Use admin-scheduled-ride-action / DEFINER emergency RPCs.';

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
  v_protected text[];
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

    -- Phase 3 final: refuse protected scheduled marketplace / dispatch patches.
    IF v_table = 'trips'
       AND current_setting('onecab.allow_scheduled_trip_mutate', true) IS DISTINCT FROM '1'
    THEN
      v_protected := public._admin_trips_protected_mutate_columns();
      FOR v_key IN SELECT key FROM jsonb_each(v_patch) LOOP
        IF lower(v_key) = ANY (v_protected) THEN
          RAISE EXCEPTION
            'not authorized: protected scheduled field % — use admin-scheduled-ride-action',
            lower(v_key)
            USING ERRCODE = '42501';
        END IF;
      END LOOP;
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

COMMENT ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) IS
  'Page-gated mutate. UPDATE refuses protected scheduled marketplace fields unless onecab.allow_scheduled_trip_mutate=1. Sets onecab.admin_page_mutate for document guards.';

-- ── 3) Assign Now — action-level RBAC + audit in same transaction ────────────
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
  v_uid uuid := auth.uid();
  v_is_service boolean := current_setting('request.jwt.claim.role', true) = 'service_role';
  v_previous jsonb;
BEGIN
  IF NOT v_is_service THEN
    IF v_uid IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Authentication required');
    END IF;
    IF NOT public.staff_has_page_access('scheduled-rides') THEN
      RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Scheduled Rides page access required');
    END IF;
    IF NOT public.staff_has_action(v_uid, 'scheduled_rides.assign') THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'ACTION_PERMISSION_DENIED',
        'message', 'scheduled_rides.assign required'
      );
    END IF;
  END IF;

  IF p_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_REQUIRED');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  v_previous := jsonb_build_object(
    'scheduled_status', v_trip.scheduled_status,
    'confirmed_driver_id', v_trip.confirmed_driver_id,
    'driver_id', v_trip.driver_id,
    'dispatch_mode', v_trip.dispatch_mode,
    'status', v_trip.status
  );

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

  -- Same transaction: refuse success if audit cannot be recorded (staff path).
  IF NOT v_is_service AND v_uid IS NOT NULL THEN
    INSERT INTO public.audit_logs (event_type, user_id, trip_id, details)
    VALUES (
      'ADMIN_SCHEDULED_ASSIGN_NOW',
      v_uid,
      p_trip_id,
      jsonb_build_object(
        'previous', v_previous,
        'resulting', jsonb_build_object(
          'scheduled_status', 'driver_assigned',
          'confirmed_driver_id', p_driver_id,
          'driver_id', null,
          'status', 'scheduled'
        ),
        'source', 'admin_assign_scheduled_driver',
        'at', v_now
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'confirmed_driver_id', p_driver_id
  );
END;
$fn$;

COMMENT ON FUNCTION public.admin_assign_scheduled_driver(uuid, uuid) IS
  'Atomic Admin Assign Now: page+action RBAC (scheduled_rides.assign), assert_payment_gate, preconfirm, audit in one transaction. Service-role may call after Edge action check.';

-- ── 4) Airport hold release — persist-failure latch only (existing Custom Zones SSOT)
-- Refuse while airport_pricing + airport_charge_pence still missing/zero.
-- Valid zero-charge routes never stamp airport_pricing (decideDispatchAfterFareEnrich).
CREATE OR REPLACE FUNCTION public.release_scheduled_airport_broadcast_hold(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_hold text;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  v_hold := COALESCE(v_trip.scheduled_hold_reason, '');
  IF v_hold = 'airport_pricing'
     AND COALESCE(v_trip.airport_charge_pence, 0) <= 0
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'AIRPORT_PRICING_UNRESOLVED',
      'message', 'Existing mandatory airport charge has not been persisted yet'
    );
  END IF;

  PERFORM set_config('onecab.release_airport_broadcast_hold', '1', true);
  UPDATE public.trips
  SET broadcast_enabled = true,
      scheduled_hold_reason = CASE
        WHEN scheduled_hold_reason = 'airport_pricing'
             AND scheduled_status = 'admin_held'
          THEN 'publication_pending'
        WHEN scheduled_hold_reason = 'airport_pricing'
          THEN NULL
        ELSE scheduled_hold_reason
      END,
      updated_at = now()
  WHERE id = p_trip_id;

  RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id);
END;
$function$;

COMMENT ON FUNCTION public.release_scheduled_airport_broadcast_hold(uuid) IS
  'Clears broadcast latch after existing Custom Zones airport_charge_pence is persisted. Not a pricing calculator; not manual approval for normal bookings.';

COMMIT;
