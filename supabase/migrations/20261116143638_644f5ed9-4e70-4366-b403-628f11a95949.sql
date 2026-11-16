-- Admin page RPCs: caller values are bound as EXECUTE parameters, never spliced
-- into SQL text. Riders list and service-area lookup no longer use dynamic SQL.

DROP FUNCTION IF EXISTS public._admin_page_patch_value(text, text, jsonb);
DROP FUNCTION IF EXISTS public._admin_page_quote_json_scalar(jsonb);
DROP FUNCTION IF EXISTS public._admin_page_build_or_groups(text, jsonb, text[]);
DROP FUNCTION IF EXISTS public._admin_page_pred_group(text, jsonb, text[]);
DROP FUNCTION IF EXISTS public._admin_page_pred_one(text, jsonb, text[]);

CREATE OR REPLACE FUNCTION public._admin_page_col_type(p_table text, p_col text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_type text;
BEGIN
  IF lower(p_table) = 'trips'
     AND lower(p_col) IN ('trip_history_event_at', 'missed_cancelled_event_at') THEN
    RETURN 'timestamp with time zone';
  END IF;
  SELECT format_type(a.atttypid, NULL)
    INTO v_type
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass(format('public.%I', lower(p_table)))
     AND a.attname = lower(p_col)
     AND a.attnum > 0
     AND NOT a.attisdropped;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'not authorized: unknown column (%)', lower(p_col) USING ERRCODE = '42501';
  END IF;
  RETURN v_type;
END;
$function$;

CREATE OR REPLACE FUNCTION public._admin_page_bind_value(p_type text, p_val jsonb, p_ref text, p_assign boolean)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_kind text := COALESCE(jsonb_typeof(p_val), 'null');
BEGIN
  IF p_type IN ('jsonb', 'json') THEN
    RETURN format('NULLIF(%s, %L::jsonb)::%s', p_ref, 'null', p_type);
  END IF;
  IF v_kind = 'object' THEN
    RAISE EXCEPTION 'not authorized: object values are not supported' USING ERRCODE = '42501';
  END IF;
  IF v_kind = 'array' THEN
    RETURN format(
      'ARRAY(SELECT jsonb_array_elements_text(%s))::%s',
      p_ref,
      CASE WHEN right(p_type, 2) = '[]' THEN p_type ELSE p_type || '[]' END
    );
  END IF;
  IF v_kind = 'number' AND p_type IN ('smallint', 'integer', 'bigint') THEN
    IF p_assign THEN
      RETURN format('(%s #>> %L)::numeric::%s', p_ref, '{}', p_type);
    END IF;
    RETURN format('(%s #>> %L)::numeric', p_ref, '{}');
  END IF;
  RETURN format('(%s #>> %L)::%s', p_ref, '{}', p_type);
END;
$function$;

CREATE FUNCTION public._admin_page_pred_one(p_table text, p_filter jsonb, p_allowed_cols text[], p_path text[])
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_op text := lower(coalesce(p_filter->>'op', ''));
  v_col text := lower(coalesce(p_filter->>'col', ''));
  v_val jsonb := p_filter->'val';
  v_expr text;
  v_type text;
  v_elem_type text;
  v_ref text;
BEGIN
  IF v_col = '' OR NOT (v_col = ANY (p_allowed_cols)) THEN
    RAISE EXCEPTION 'not authorized: column not allowed (%)', v_col USING ERRCODE = '42501';
  END IF;

  v_expr := public._admin_page_col_expr(p_table, v_col);
  v_ref := format('($1 #> %L::text[])', (p_path || ARRAY['val'])::text);

  IF v_op = 'is_null' THEN
    RETURN format('%s IS NULL', v_expr);
  ELSIF v_op = 'not_null' THEN
    RETURN format('%s IS NOT NULL', v_expr);
  ELSIF v_op = 'ilike' THEN
    RETURN format('(%s)::text ILIKE (%s #>> %L)', v_expr, v_ref, '{}');
  END IF;

  v_type := public._admin_page_col_type(p_table, v_col);

  IF v_op IN ('eq', 'neq', 'gt', 'gte', 'lt', 'lte') THEN
    RETURN format(
      '%s %s %s',
      v_expr,
      CASE v_op
        WHEN 'eq' THEN '='
        WHEN 'neq' THEN 'IS DISTINCT FROM'
        WHEN 'gt' THEN '>'
        WHEN 'gte' THEN '>='
        WHEN 'lt' THEN '<'
        ELSE '<='
      END,
      public._admin_page_bind_value(v_type, v_val, v_ref, false)
    );
  ELSIF v_op IN ('in', 'not_in') THEN
    IF COALESCE(jsonb_typeof(v_val), 'null') <> 'array' THEN
      RETURN CASE WHEN v_op = 'in' THEN 'FALSE' ELSE 'TRUE' END;
    END IF;
    IF jsonb_array_length(v_val) = 0 THEN
      RETURN CASE WHEN v_op = 'in' THEN 'FALSE' ELSE 'TRUE' END;
    END IF;
    v_elem_type := CASE WHEN v_type IN ('smallint', 'integer', 'bigint') THEN 'numeric' ELSE v_type END;
    RETURN format(
      CASE WHEN v_op = 'in'
        THEN '%s = ANY (ARRAY(SELECT jsonb_array_elements_text(%s))::%s[])'
        ELSE 'NOT (%s = ANY (ARRAY(SELECT jsonb_array_elements_text(%s))::%s[]))'
      END,
      v_expr, v_ref, v_elem_type
    );
  END IF;

  RAISE EXCEPTION 'not authorized: filter op not allowed (%)', v_op USING ERRCODE = '42501';
END;
$function$;

CREATE FUNCTION public._admin_page_pred_group(p_table text, p_filters jsonb, p_allowed_cols text[], p_path text[])
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_parts text[] := ARRAY[]::text[];
  v_filter jsonb;
  v_idx bigint;
BEGIN
  IF p_filters IS NULL OR jsonb_typeof(p_filters) <> 'array' THEN
    RETURN 'TRUE';
  END IF;
  IF jsonb_array_length(p_filters) = 0 THEN
    RETURN 'TRUE';
  END IF;
  FOR v_filter, v_idx IN SELECT e.value, e.ord - 1 FROM jsonb_array_elements(p_filters) WITH ORDINALITY AS e(value, ord) LOOP
    v_parts := array_append(
      v_parts,
      public._admin_page_pred_one(p_table, v_filter, p_allowed_cols, p_path || v_idx::text)
    );
  END LOOP;
  RETURN '(' || array_to_string(v_parts, ' AND ') || ')';
END;
$function$;

CREATE FUNCTION public._admin_page_build_or_groups(p_table text, p_or_groups jsonb, p_allowed_cols text[], p_path text[])
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_or_parts text[] := ARRAY[]::text[];
  v_group jsonb;
  v_idx bigint;
BEGIN
  IF p_or_groups IS NULL OR jsonb_typeof(p_or_groups) <> 'array' THEN
    RETURN NULL;
  END IF;
  IF jsonb_array_length(p_or_groups) = 0 THEN
    RETURN NULL;
  END IF;
  FOR v_group, v_idx IN SELECT e.value, e.ord - 1 FROM jsonb_array_elements(p_or_groups) WITH ORDINALITY AS e(value, ord) LOOP
    v_or_parts := array_append(
      v_or_parts,
      public._admin_page_pred_group(p_table, v_group, p_allowed_cols, p_path || v_idx::text)
    );
  END LOOP;
  RETURN '(' || array_to_string(v_or_parts, ' OR ') || ')';
END;
$function$;

CREATE OR REPLACE FUNCTION public._admin_page_build_where(p_table text, p_args jsonb, p_allowed_cols text[])
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_parts text[] := ARRAY[]::text[];
  v_or text;
  v_extra jsonb;
  v_block jsonb;
  v_idx bigint;
  v_block_sql text;
BEGIN
  v_parts := array_append(
    v_parts,
    public._admin_page_pred_group(p_table, p_args->'filters', p_allowed_cols, ARRAY['filters'])
  );

  v_or := public._admin_page_build_or_groups(p_table, p_args->'or_groups', p_allowed_cols, ARRAY['or_groups']);
  IF v_or IS NOT NULL THEN
    v_parts := array_append(v_parts, v_or);
  END IF;

  v_extra := p_args->'and_or_groups';
  IF v_extra IS NOT NULL AND jsonb_typeof(v_extra) = 'array' THEN
    FOR v_block, v_idx IN SELECT e.value, e.ord - 1 FROM jsonb_array_elements(v_extra) WITH ORDINALITY AS e(value, ord) LOOP
      v_block_sql := public._admin_page_build_or_groups(
        p_table, v_block, p_allowed_cols, ARRAY['and_or_groups', v_idx::text]
      );
      IF v_block_sql IS NOT NULL THEN
        v_parts := array_append(v_parts, v_block_sql);
      END IF;
    END LOOP;
  END IF;

  RETURN '(' || array_to_string(v_parts, ' AND ') || ')';
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_page_select(p_page_slug text, p_table text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_table text := lower(btrim(p_table));
  v_page text := lower(btrim(p_page_slug));
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_allowed text[];
  v_cols_in jsonb;
  v_col text;
  v_select_cols text[] := ARRAY[]::text[];
  v_select_sql text;
  v_where text;
  v_order jsonb;
  v_order_sql text := '';
  v_ord jsonb;
  v_ord_parts text[] := ARRAY[]::text[];
  v_ord_col text;
  v_limit int := 100;
  v_offset int := 0;
  v_count_only boolean := false;
  v_include_count boolean := false;
  v_rows jsonb := '[]'::jsonb;
  v_count bigint := NULL;
BEGIN
  PERFORM public.admin_assert_staff_page(v_page);

  IF NOT public._admin_page_table_allowed(v_page, v_table) THEN
    RAISE EXCEPTION 'not authorized: page % cannot read %', v_page, v_table
      USING ERRCODE = '42501';
  END IF;

  v_allowed := public._admin_page_columns(v_table);
  IF cardinality(v_allowed) = 0 THEN
    RAISE EXCEPTION 'not authorized: unknown table %', v_table USING ERRCODE = '42501';
  END IF;

  v_count_only := COALESCE((v_args->>'count_only')::boolean, false);
  v_include_count := COALESCE((v_args->>'include_count')::boolean, false);
  v_limit := LEAST(GREATEST(COALESCE((v_args->>'limit')::int, 100), 0), 500);
  v_offset := GREATEST(COALESCE((v_args->>'offset')::int, 0), 0);

  v_where := public._admin_page_build_where(v_table, v_args, v_allowed);

  IF v_count_only OR v_include_count THEN
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %s', v_table, v_where)
      INTO v_count
      USING v_args;
    IF v_count_only THEN
      RETURN jsonb_build_object('count', v_count, 'rows', '[]'::jsonb);
    END IF;
  END IF;

  v_cols_in := v_args->'columns';
  IF v_cols_in IS NULL OR jsonb_typeof(v_cols_in) <> 'array' OR jsonb_array_length(v_cols_in) = 0 THEN
    v_select_cols := v_allowed;
  ELSE
    FOR v_col IN SELECT lower(value #>> '{}') FROM jsonb_array_elements(v_cols_in) LOOP
      IF v_col = ANY (v_allowed) THEN
        v_select_cols := array_append(v_select_cols, v_col);
      END IF;
    END LOOP;
    IF cardinality(v_select_cols) = 0 THEN
      RAISE EXCEPTION 'not authorized: no allowed columns requested' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_select_sql := array_to_string(
    ARRAY(
      SELECT format('%s AS %I', public._admin_page_col_expr(v_table, c), c)
      FROM unnest(v_select_cols) AS c
    ),
    ', '
  );

  v_order := v_args->'order';
  IF v_order IS NOT NULL AND jsonb_typeof(v_order) = 'array' THEN
    FOR v_ord IN SELECT * FROM jsonb_array_elements(v_order) LOOP
      v_ord_col := lower(coalesce(v_ord->>'col', ''));
      IF v_ord_col = ANY (v_allowed) THEN
        v_ord_parts := array_append(
          v_ord_parts,
          format(
            '%s %s NULLS LAST',
            public._admin_page_col_expr(v_table, v_ord_col),
            CASE WHEN COALESCE((v_ord->>'asc')::boolean, true) THEN 'ASC' ELSE 'DESC' END
          )
        );
      END IF;
    END LOOP;
  END IF;
  IF cardinality(v_ord_parts) > 0 THEN
    v_order_sql := ' ORDER BY ' || array_to_string(v_ord_parts, ', ');
  END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(q)), ''[]''::jsonb) FROM (SELECT %s FROM public.%I WHERE %s%s LIMIT $2 OFFSET $3) q',
    v_select_sql,
    v_table,
    v_where,
    v_order_sql
  )
    INTO v_rows
    USING v_args, v_limit, v_offset;

  RETURN jsonb_build_object(
    'rows', COALESCE(v_rows, '[]'::jsonb),
    'count', v_count
  );
END;
$function$;

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
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_pages text[];
  v_allowed text[];
  v_protected text[];
  v_select_cols text[];
  v_patch jsonb := COALESCE(v_args->'patch', '{}'::jsonb);
  v_patch_vals jsonb := '[]'::jsonb;
  v_n int := 0;
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
    v_id := NULLIF(v_args->>'id', '')::uuid;
    v_select_cols := public._admin_page_columns(v_table);
    IF v_id IS NOT NULL THEN
      v_where := 'id = $3';
    END IF;
    IF v_args ? 'filters' OR v_args ? 'or_groups' OR v_args ? 'and_or_groups' THEN
      v_where := '(' || v_where || ' AND ' ||
        public._admin_page_build_where(v_table, v_args, v_select_cols) ||
        ')';
    END IF;
    IF v_id IS NULL AND v_where = 'TRUE' THEN
      RAISE EXCEPTION 'id or filters required for update';
    END IF;

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
        v_patch_vals := v_patch_vals || jsonb_build_array(v_patch->v_key);
        v_set_parts := array_append(
          v_set_parts,
          format(
            '%I = %s',
            lower(v_key),
            public._admin_page_bind_value(
              public._admin_page_col_type(v_table, lower(v_key)),
              v_patch->v_key,
              format('($2 -> %s)', v_n),
              true
            )
          )
        );
        v_n := v_n + 1;
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
    EXECUTE v_sql INTO v_rows USING v_args, v_patch_vals, v_id;
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
        v_patch_vals := v_patch_vals || jsonb_build_array(v_patch->v_key);
        v_col_list := array_append(v_col_list, lower(v_key));
        v_val_list := array_append(
          v_val_list,
          public._admin_page_bind_value(
            public._admin_page_col_type(v_table, lower(v_key)),
            v_patch->v_key,
            format('($2 -> %s)', v_n),
            true
          )
        );
        v_n := v_n + 1;
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
    EXECUTE v_sql INTO v_row USING v_args, v_patch_vals;
    RETURN jsonb_build_object('row', v_row);

  ELSIF v_op = 'delete' THEN
    IF v_table NOT IN (
      'documents','driver_service_areas','corporate_fare_rules','document_types'
    ) THEN
      RAISE EXCEPTION 'not authorized: delete not allowed for % via this RPC', v_table
        USING ERRCODE = '42501';
    END IF;
    v_select_cols := public._admin_page_columns(v_table);
    SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_args->'ids', '[]'::jsonb))::uuid)
      INTO v_ids;
    IF v_ids IS NOT NULL AND cardinality(v_ids) > 0 THEN
      v_where := 'id = ANY ($2)';
    ELSIF v_args ? 'filters' OR v_args ? 'or_groups' OR v_args ? 'and_or_groups' THEN
      v_where := public._admin_page_build_where(v_table, v_args, v_select_cols);
    ELSE
      RAISE EXCEPTION 'ids or filters required for delete';
    END IF;
    EXECUTE format('DELETE FROM public.%I WHERE %s', v_table, v_where) USING v_args, v_ids;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN jsonb_build_object('deleted', v_count);

  ELSE
    RAISE EXCEPTION 'not authorized: op %', v_op USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_list_riders_page(p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text := NULLIF(lower(btrim(COALESCE(p_args->>'status', ''))), '');
  v_search text := NULLIF(btrim(COALESCE(p_args->>'search', '')), '');
  v_limit int := LEAST(GREATEST(COALESCE((p_args->>'limit')::int, 50), 1), 200);
  v_offset int := GREATEST(COALESCE((p_args->>'offset')::int, 0), 0);
  v_id uuid := NULLIF(p_args->>'id', '')::uuid;
  v_count_only boolean := COALESCE((p_args->>'count_only')::boolean, false);
  v_min_trips int := (p_args->>'min_trip_count')::int;
  v_created_gte timestamptz := NULLIF(p_args->>'created_gte', '')::timestamptz;
  v_pattern text;
  v_count bigint;
  v_rows jsonb;
BEGIN
  PERFORM public.admin_assert_staff_page('riders');

  IF v_status = 'all' THEN
    v_status := NULL;
  END IF;
  v_pattern := CASE WHEN v_search IS NULL THEN NULL ELSE '%' || v_search || '%' END;

  WITH trip_stats AS (
    SELECT t.passenger_id, count(*)::integer AS trip_count, max(t.created_at) AS last_trip_at
    FROM public.trips t
    WHERE t.passenger_id IS NOT NULL AND t.status = 'completed'
    GROUP BY t.passenger_id
  ),
  filtered AS (
    SELECT
      c.id,
      c.user_id,
      c.customer_code,
      c.first_name,
      c.last_name,
      c.phone,
      c.created_at,
      c.updated_at,
      c.rider_status,
      c.email_verified,
      c.phone_verified,
      c.identity_verified_at,
      c.identity_provider,
      c.name_edit_locked,
      c.name_unlocked_at,
      COALESCE(ts.trip_count, 0)::integer AS trip_count,
      ts.last_trip_at
    FROM public.customers c
    LEFT JOIN trip_stats ts ON ts.passenger_id = c.id
    WHERE c.deleted_at IS NULL
      AND (v_id IS NULL OR c.id = v_id)
      AND (v_status IS NULL OR c.rider_status = v_status)
      AND (
        v_pattern IS NULL
        OR c.first_name ILIKE v_pattern
        OR c.last_name ILIKE v_pattern
        OR c.phone ILIKE v_pattern
        OR c.customer_code ILIKE v_pattern
      )
      AND (v_created_gte IS NULL OR c.created_at >= v_created_gte)
      AND (v_min_trips IS NULL OR COALESCE(ts.trip_count, 0) >= v_min_trips)
  ),
  page AS (
    SELECT
      f.id,
      f.user_id,
      f.customer_code,
      f.first_name,
      f.last_name,
      f.phone,
      public.admin_get_user_email(f.user_id) AS email,
      f.created_at,
      f.updated_at,
      f.rider_status,
      f.email_verified,
      f.phone_verified,
      f.identity_verified_at,
      f.identity_provider,
      f.name_edit_locked,
      f.name_unlocked_at,
      f.trip_count,
      f.last_trip_at
    FROM filtered f
    ORDER BY f.created_at DESC
    LIMIT CASE WHEN v_count_only THEN 0 ELSE v_limit END
    OFFSET v_offset
  )
  SELECT
    (SELECT count(*) FROM filtered),
    (SELECT COALESCE(jsonb_agg(row_to_json(p) ORDER BY p.created_at DESC), '[]'::jsonb) FROM page p)
  INTO v_count, v_rows;

  IF v_count_only THEN
    RETURN jsonb_build_object('count', v_count, 'rows', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::jsonb), 'count', v_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_service_areas_lookup(p_page_slug text, p_args jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_page text := lower(btrim(p_page_slug));
  v_active_only boolean := COALESCE((p_args->>'active_only')::boolean, false);
  v_include_archived boolean := COALESCE((p_args->>'include_archived')::boolean, false);
  v_ids uuid[];
  v_limit int := LEAST(GREATEST(COALESCE((p_args->>'limit')::int, 500), 1), 1000);
  v_tips boolean;
  v_prefixes boolean;
  v_commission boolean;
  v_policy boolean;
  v_geo boolean;
  v_rows jsonb;
BEGIN
  PERFORM public.admin_assert_staff_page(v_page);
  IF NOT public._admin_service_areas_lookup_page_allowed(v_page) THEN
    RAISE EXCEPTION 'not authorized: page % cannot lookup service_areas', v_page
      USING ERRCODE = '42501';
  END IF;

  SELECT ARRAY(
    SELECT jsonb_array_elements_text(COALESCE(p_args->'ids', '[]'::jsonb))::uuid
  ) INTO v_ids;

  -- geo_boundary + management prefixes: services page only (not OR'd across pages).
  -- Commission/CW policy columns: services|service-area-pricing|commission-wallet|payout-ledger only.
  v_tips := v_page = ANY (ARRAY['services','service-area-pricing','payout-ledger']);
  v_prefixes := v_page = 'services';
  v_commission := v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger']);
  v_policy := v_page = ANY (ARRAY['services','service-area-pricing','commission-wallet','payout-ledger','manual-trip']);
  v_geo := v_page = ANY (ARRAY['services','custom-zones','driver-demand-zones','zone-pricing']);

  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.name), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT
        sa.id,
        sa.name,
        sa.code,
        sa.country,
        sa.timezone,
        sa.currency_code,
        sa.distance_unit,
        sa.region_id,
        sa.is_active,
        sa.archived_at,
        sa.center_lat,
        sa.center_lng,
        sa.created_at,
        sa.updated_at,
        sa.financial_model,
        sa.commission_wallet_enabled,
        sa.commission_wallet_currency,
        sa.welcome_credit_enabled,
        sa.welcome_credit_amount_minor,
        sa.welcome_credit_max_drivers,
        sa.payment_provider,
        sa.driver_payout_gateway,
        sa.customer_payment_gateway,
        CASE WHEN v_tips THEN sa.tips_enabled END AS tips_enabled,
        CASE WHEN v_tips THEN sa.early_cashout_enabled END AS early_cashout_enabled,
        CASE WHEN v_prefixes THEN sa.trip_id_prefix END AS trip_id_prefix,
        CASE WHEN v_prefixes THEN sa.driver_id_prefix END AS driver_id_prefix,
        CASE WHEN v_commission THEN sa.commission_reserve_enabled END AS commission_reserve_enabled,
        CASE WHEN v_commission THEN sa.commission_topup_provider END AS commission_topup_provider,
        CASE WHEN v_commission THEN sa.commission_wallet_topup_enabled END AS commission_wallet_topup_enabled,
        CASE WHEN v_commission THEN sa.commission_wallet_minimum_balance_minor END AS commission_wallet_minimum_balance_minor,
        CASE WHEN v_policy THEN sa.customer_payment_policy END AS customer_payment_policy,
        CASE WHEN v_policy THEN sa.cash_upfront_policy_notice END AS cash_upfront_policy_notice,
        CASE WHEN v_geo THEN sa.geo_boundary END AS geo_boundary,
        CASE WHEN v_prefixes THEN
          jsonb_build_object(
            'id', r.id,
            'name', r.name,
            'currency_code', r.currency_code,
            'distance_unit', r.distance_unit,
            'timezone', r.timezone,
            'status', r.status,
            'country_code', r.country_code,
            'geo_boundary', r.geo_boundary
          )
        ELSE
          jsonb_build_object(
            'currency_code', r.currency_code,
            'distance_unit', r.distance_unit,
            'name', r.name,
            'country_code', r.country_code
          )
        END AS region
      FROM public.service_areas sa
      LEFT JOIN public.regions r ON r.id = sa.region_id
      WHERE (cardinality(v_ids) = 0 OR sa.id = ANY (v_ids))
        AND (v_include_archived OR sa.archived_at IS NULL)
        AND (NOT v_active_only OR sa.is_active = true)
      ORDER BY sa.name
      LIMIT v_limit
    ) q;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::jsonb), 'count', jsonb_array_length(COALESCE(v_rows, '[]'::jsonb)));
END;
$function$;

REVOKE ALL ON FUNCTION public._admin_page_col_type(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._admin_page_bind_value(text, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._admin_page_pred_one(text, jsonb, text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._admin_page_pred_group(text, jsonb, text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._admin_page_build_or_groups(text, jsonb, text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._admin_page_build_where(text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._admin_page_col_type(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public._admin_page_bind_value(text, jsonb, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public._admin_page_pred_one(text, jsonb, text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public._admin_page_pred_group(text, jsonb, text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public._admin_page_build_or_groups(text, jsonb, text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public._admin_page_build_where(text, jsonb, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.admin_page_select(text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_riders_page(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_service_areas_lookup(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_page_select(text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_page_mutate(text, text, text, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_page(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_service_areas_lookup(text, jsonb) TO authenticated, service_role;