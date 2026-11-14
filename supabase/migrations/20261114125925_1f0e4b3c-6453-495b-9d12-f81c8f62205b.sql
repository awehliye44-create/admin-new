-- Column-type-aware patch value for admin_page_mutate.
-- json/jsonb columns receive the JSON value verbatim (objects and arrays kept intact,
-- [] stays []); every other column keeps the strict scalar/array quoting.
CREATE OR REPLACE FUNCTION public._admin_page_patch_value(p_table text, p_col text, p_val jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass(format('public.%I', p_table))
     AND a.attname = p_col
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF v_type IN ('jsonb', 'json') THEN
    IF p_val IS NULL OR p_val = 'null'::jsonb THEN
      RETURN 'NULL';
    END IF;
    RETURN quote_literal(p_val::text) || '::' || v_type;
  END IF;

  RETURN public._admin_page_quote_json_scalar(p_val);
END;
$function$;

REVOKE ALL ON FUNCTION public._admin_page_patch_value(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_page_patch_value(text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_page_mutate(p_page_slug text, p_table text, p_op text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
          format('%I = %s', lower(v_key), public._admin_page_patch_value(v_table, lower(v_key), v_patch->v_key))
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
          public._admin_page_patch_value(v_table, lower(v_key), v_patch->v_key)
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
$function$;

CREATE OR REPLACE FUNCTION public.enforce_digital_payment_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_method text := UPPER(COALESCE(NEW.payment_method, ''));
  v_new_status text := LOWER(COALESCE(NEW.status, ''));
  v_gated_states text[] := ARRAY[
    'searching','searching_new_driver','broadcasting',
    'offered','offering','negotiating','driver_notified',
    'awaiting_driver_response','accepted','confirmed',
    'driver_assigned','assigned','queued',
    'en_route','en_route_to_pickup','driver_en_route','enroute_to_pickup',
    'driver_arriving','arrived','arrived_pickup','arrived_at_pickup',
    'at_pickup','pickup_waiting','waiting','waiting_at_pickup',
    'in_progress','started','on_trip','ongoing','trip_started','completed',
    'scheduled'
  ];
  v_ps RECORD;
  v_fm text := UPPER(COALESCE((NEW.financial_model)::text, ''));
  v_session_status text;
BEGIN
  IF v_fm = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN NEW;
  END IF;

  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  IF NOT (v_new_status = ANY(v_gated_states)) THEN
    RETURN NEW;
  END IF;

  -- Mid-trip lost authorisation: the passenger is already on board and
  -- assert_trip_completion_customer_payment_gate has flagged the trip
  -- recovery_required. Ending the ride must not be blocked; support recovers payment.
  IF TG_OP = 'UPDATE'
     AND v_new_status = 'completed'
     AND LOWER(COALESCE(OLD.status, '')) IN ('in_progress','started','on_trip','ongoing','trip_started')
     AND LOWER(COALESCE(NEW.payment_status, '')) = 'recovery_required'
  THEN
    RETURN NEW;
  END IF;

  IF NEW.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: digital-payment trip requires payment_session_id (trip=%, method=%)',
      NEW.id, v_method USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, provider_state, currency, authorised_amount_pence, hold_release_state
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = NEW.payment_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session % not found', NEW.payment_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- MUST cast enum → text before IN-list; US "canceled" is not a valid enum label
  -- and crashes ALL digital trip inserts (MK-261105-002 outage).
  v_session_status := lower(COALESCE((v_ps.status)::text, ''));

  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','AUTHORIZED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=% for session % (trip=%)',
      v_ps.provider_state, v_ps.id, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF v_session_status IN (
    'cancelled','canceled','failed','expired','abandoned','payment_orphaned','released'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=% (trip=%)', v_ps.status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF lower(COALESCE(v_ps.hold_release_state, '')) IN ('released', 'releasing') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold_release_state=% (trip=%)',
      v_ps.hold_release_state, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF LOWER(COALESCE(v_ps.currency,'')) <> LOWER(COALESCE(NEW.currency, v_ps.currency, '')) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: currency mismatch session=% trip=%',
      v_ps.currency, NEW.currency USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence not positive for session %',
      v_ps.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;