-- ============================================================
-- HOTFIX: admin_list_riders_page crashes when min_trip_count omitted
--
-- format('%s', NULL) yields an empty string, producing:
--   WHERE ( IS NULL OR trip_count >= 0)
-- which is a syntax error. Riders page then shows empty (RPC error).
--
-- Use %L so a NULL arg becomes the SQL NULL literal.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_list_riders_page(
  p_args jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_status text := NULLIF(lower(btrim(COALESCE(p_args->>'status', ''))), '');
  v_search text := NULLIF(btrim(COALESCE(p_args->>'search', '')), '');
  v_limit int := LEAST(GREATEST(COALESCE((p_args->>'limit')::int, 50), 1), 200);
  v_offset int := GREATEST(COALESCE((p_args->>'offset')::int, 0), 0);
  v_id uuid := NULLIF(p_args->>'id', '')::uuid;
  v_count_only boolean := COALESCE((p_args->>'count_only')::boolean, false);
  v_min_trips int := (p_args->>'min_trip_count')::int;
  v_created_gte timestamptz := NULLIF(p_args->>'created_gte', '')::timestamptz;
  v_where text := 'c.deleted_at IS NULL';
  v_sql text;
  v_count bigint;
  v_rows jsonb;
BEGIN
  PERFORM public.admin_assert_staff_page('riders');

  IF v_id IS NOT NULL THEN
    v_where := v_where || format(' AND c.id = %L', v_id);
  END IF;
  IF v_status IS NOT NULL AND v_status <> 'all' THEN
    v_where := v_where || format(' AND c.rider_status = %L', v_status);
  END IF;
  IF v_search IS NOT NULL THEN
    v_where := v_where || format(
      ' AND (c.first_name ILIKE %L OR c.last_name ILIKE %L OR c.phone ILIKE %L OR c.customer_code ILIKE %L)',
      '%' || v_search || '%',
      '%' || v_search || '%',
      '%' || v_search || '%',
      '%' || v_search || '%'
    );
  END IF;
  IF v_created_gte IS NOT NULL THEN
    v_where := v_where || format(' AND c.created_at >= %L', v_created_gte);
  END IF;

  v_sql := format(
    $q$
    WITH base AS (
      SELECT
        c.id,
        c.user_id,
        c.customer_code,
        c.first_name,
        c.last_name,
        c.phone,
        public.admin_get_user_email(c.user_id) AS email,
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
      LEFT JOIN (
        SELECT t.passenger_id, count(*)::integer AS trip_count, max(t.created_at) AS last_trip_at
        FROM public.trips t
        WHERE t.passenger_id IS NOT NULL AND t.status = 'completed'
        GROUP BY t.passenger_id
      ) ts ON ts.passenger_id = c.id
      WHERE %s
    )
    SELECT * FROM base
    WHERE (%L IS NULL OR trip_count >= %s)
    $q$,
    v_where,
    v_min_trips,
    COALESCE(v_min_trips, 0)
  );

  EXECUTE 'SELECT count(*) FROM (' || v_sql || ') s' INTO v_count;
  IF v_count_only THEN
    RETURN jsonb_build_object('count', v_count, 'rows', '[]'::jsonb);
  END IF;

  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(q)), ''[]''::jsonb) FROM (%s ORDER BY created_at DESC LIMIT %s OFFSET %s) q',
    v_sql,
    v_limit,
    v_offset
  ) INTO v_rows;

  RETURN jsonb_build_object('rows', COALESCE(v_rows, '[]'::jsonb), 'count', v_count);
END;
$fn$;

COMMENT ON FUNCTION public.admin_list_riders_page(jsonb) IS
  'Page-gated riders list/count. min_trip_count optional — NULL must format as SQL NULL (%L), not empty %s.';

REVOKE ALL ON FUNCTION public.admin_list_riders_page(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_riders_page(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_page(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_riders_page(jsonb) TO service_role;

COMMIT;
