-- Fix Admin document approve / any admin_page_mutate UPDATE:
-- The UPDATE path wrapped data-modifying SQL as
--   SELECT jsonb_agg(q) FROM (UPDATE … RETURNING to_jsonb(table.*)) q
-- which Postgres rejects (often as: syntax error at or near ".").
-- Use a writable CTE instead:
--   WITH updated AS (UPDATE … RETURNING *) SELECT jsonb_agg(to_jsonb(u)) FROM updated u
--
-- Also mark the session so document write guards honour page-gated staff mutates
-- (staff may have documents page access without app_role=admin; without this,
-- guard_driver_document_writes silently forced status back to pending).

CREATE OR REPLACE FUNCTION public.guard_driver_document_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
BEGIN
  -- Page-gated Admin mutates (admin_page_mutate) already passed staff_has_page_access.
  IF current_setting('onecab.admin_page_mutate', true) = '1' THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  -- Service-role / system migrations: auth.uid() null with service_role
  IF auth.uid() IS NULL AND auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Versioning demote/link of an approved row must keep status='approved'.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'approved'
     AND public.document_update_is_versioning_only(OLD, NEW) THEN
    RETURN NEW;
  END IF;

  NEW.status := 'pending';
  NEW.reviewed_by := NULL;
  NEW.reviewed_at := NULL;
  IF TG_OP = 'INSERT' THEN
    NEW.rejection_reason := NULL;
  ELSE
    NEW.rejection_reason := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_document_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
  today_london date;
BEGIN
  IF current_setting('onecab.admin_page_mutate', true) = '1' THEN
    RETURN NEW;
  END IF;

  v_is_admin := public.has_role(auth.uid(), 'admin'::app_role);
  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  today_london := public.driver_compliance_today_london();

  IF OLD.status = 'approved' THEN
    IF OLD.expiry_date IS NOT NULL AND OLD.expiry_date < today_london THEN
      RETURN NEW;
    END IF;
    IF public.document_update_is_versioning_only(OLD, NEW) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot modify an approved document. Contact admin to unlock it.';
  END IF;

  RETURN NEW;
END;
$function$;

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

  -- Honour page-gated writes in document lock/guard triggers (txn-local).
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
    -- Writable CTE — never wrap UPDATE in FROM (subquery).
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
  'Page-gated mutate. UPDATE uses writable CTE (not FROM-subquery). Sets onecab.admin_page_mutate for document guards.';
