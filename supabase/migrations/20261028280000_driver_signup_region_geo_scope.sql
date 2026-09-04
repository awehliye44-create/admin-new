-- Driver Create Account catalogue: country + geo scoped regions; SA parent-child lock.
-- Re-materializes signup RPCs in-repo (previously live-only).

CREATE OR REPLACE FUNCTION public.region_boundary_centroid_lat(p_boundary jsonb)
RETURNS double precision
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_sum double precision := 0;
  v_n int := 0;
  v_item jsonb;
BEGIN
  IF p_boundary IS NULL OR jsonb_typeof(p_boundary) <> 'array' THEN
    RETURN NULL;
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_boundary)
  LOOP
    IF v_item ? 'lat' THEN
      v_sum := v_sum + (v_item->>'lat')::double precision;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n < 1 THEN
    RETURN NULL;
  END IF;
  RETURN v_sum / v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.region_boundary_centroid_lng(p_boundary jsonb)
RETURNS double precision
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_sum double precision := 0;
  v_n int := 0;
  v_item jsonb;
BEGIN
  IF p_boundary IS NULL OR jsonb_typeof(p_boundary) <> 'array' THEN
    RETURN NULL;
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_boundary)
  LOOP
    IF v_item ? 'lng' THEN
      v_sum := v_sum + (v_item->>'lng')::double precision;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n < 1 THEN
    RETURN NULL;
  END IF;
  RETURN v_sum / v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_signup_location_options(
  p_latitude double precision DEFAULT NULL::double precision,
  p_longitude double precision DEFAULT NULL::double precision,
  p_country_code text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_country text;
  v_regions jsonb := '[]'::jsonb;
  v_detected_region jsonb := NULL;
  v_first record;
  v_has_geo boolean := false;
BEGIN
  v_country := upper(trim(COALESCE(p_country_code, '')));
  IF v_country = 'UK' THEN
    v_country := 'GB';
  END IF;
  IF v_country = '' THEN
    v_country := NULL;
  END IF;

  -- Fail closed without country — never return the global catalogue.
  IF v_country IS NULL THEN
    RETURN jsonb_build_object(
      'detected_country_code', NULL,
      'detected_region', NULL,
      'regions', '[]'::jsonb,
      'service_areas', '[]'::jsonb,
      'unavailable_reason', 'COUNTRY_REQUIRED'
    );
  END IF;

  v_has_geo :=
    p_latitude IS NOT NULL
    AND p_longitude IS NOT NULL
    AND p_latitude BETWEEN -90 AND 90
    AND p_longitude BETWEEN -180 AND 180;

  IF v_has_geo THEN
    -- Geographic relevance: only signup regions that contain the driver point.
    SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.display_order, q.name), '[]'::jsonb)
    INTO v_regions
    FROM (
      SELECT
        r.id,
        COALESCE(NULLIF(btrim(r.display_name), ''), r.name) AS name,
        r.country_code,
        r.display_order
      FROM public.regions r
      WHERE r.status = 'active'
        AND r.signup_enabled = true
        AND r.country_code = v_country
        AND r.geo_boundary IS NOT NULL
        AND public.point_in_polygon(p_latitude, p_longitude, r.geo_boundary)
      ORDER BY r.display_order ASC, COALESCE(NULLIF(btrim(r.display_name), ''), r.name) ASC
    ) q;

    -- Same-country nearby fallback (<= 150km to boundary centroid) — never other countries.
    IF v_regions = '[]'::jsonb THEN
      SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.dist_m, q.display_order, q.name), '[]'::jsonb)
      INTO v_regions
      FROM (
        SELECT
          r.id,
          COALESCE(NULLIF(btrim(r.display_name), ''), r.name) AS name,
          r.country_code,
          r.display_order,
          public.haversine_meters(
            p_latitude,
            p_longitude,
            public.region_boundary_centroid_lat(r.geo_boundary),
            public.region_boundary_centroid_lng(r.geo_boundary)
          ) AS dist_m
        FROM public.regions r
        WHERE r.status = 'active'
          AND r.signup_enabled = true
          AND r.country_code = v_country
          AND r.geo_boundary IS NOT NULL
          AND public.region_boundary_centroid_lat(r.geo_boundary) IS NOT NULL
          AND public.region_boundary_centroid_lng(r.geo_boundary) IS NOT NULL
          AND public.haversine_meters(
            p_latitude,
            p_longitude,
            public.region_boundary_centroid_lat(r.geo_boundary),
            public.region_boundary_centroid_lng(r.geo_boundary)
          ) <= 150000
        ORDER BY 5 ASC, r.display_order ASC, COALESCE(NULLIF(btrim(r.display_name), ''), r.name) ASC
      ) q;
    END IF;
  ELSE
    -- No GPS: country-scoped signup catalogue only (never global).
    SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.display_order, q.name), '[]'::jsonb)
    INTO v_regions
    FROM (
      SELECT
        r.id,
        COALESCE(NULLIF(btrim(r.display_name), ''), r.name) AS name,
        r.country_code,
        r.display_order
      FROM public.regions r
      WHERE r.status = 'active'
        AND r.signup_enabled = true
        AND r.country_code = v_country
      ORDER BY r.display_order ASC, COALESCE(NULLIF(btrim(r.display_name), ''), r.name) ASC
    ) q;
  END IF;

  SELECT
    (r.elem->>'id')::uuid AS id,
    r.elem->>'name' AS name,
    r.elem->>'country_code' AS country_code,
    COALESCE((r.elem->>'display_order')::int, 0) AS display_order
  INTO v_first
  FROM jsonb_array_elements(COALESCE(v_regions, '[]'::jsonb)) WITH ORDINALITY AS r(elem, ord)
  ORDER BY ord
  LIMIT 1;

  IF FOUND THEN
    v_detected_region := jsonb_build_object(
      'id', v_first.id,
      'name', v_first.name,
      'country_code', v_first.country_code
    );
  END IF;

  RETURN jsonb_build_object(
    'detected_country_code', v_country,
    'detected_region', v_detected_region,
    'regions', COALESCE(v_regions, '[]'::jsonb),
    'service_areas', '[]'::jsonb,
    'unavailable_reason', CASE
      WHEN COALESCE(v_regions, '[]'::jsonb) = '[]'::jsonb THEN 'NO_SIGNUP_REGION_IN_AREA'
      ELSE NULL
    END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_signup_service_areas(p_region_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_region record;
  v_areas jsonb := '[]'::jsonb;
BEGIN
  IF p_region_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT r.id, r.status, r.signup_enabled
  INTO v_region
  FROM public.regions r
  WHERE r.id = p_region_id;

  IF NOT FOUND
     OR v_region.status IS DISTINCT FROM 'active'
     OR v_region.signup_enabled IS NOT TRUE THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.display_order, q.name), '[]'::jsonb)
  INTO v_areas
  FROM (
    SELECT
      sa.id,
      sa.name,
      sa.region_id,
      sa.display_order,
      sa.is_active,
      sa.driver_signup_enabled
    FROM public.service_areas sa
    WHERE sa.region_id = p_region_id
      AND sa.is_active = true
      AND sa.driver_signup_enabled = true
    ORDER BY sa.display_order ASC, sa.name ASC
  ) q;

  RETURN COALESCE(v_areas, '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_driver_signup_region_service_areas(
  p_region_id uuid,
  p_service_area_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_region record;
  v_sa_id uuid;
  v_sa record;
BEGIN
  IF p_region_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'REGION_REQUIRED',
      'message', 'Driving region is required.'
    );
  END IF;

  SELECT r.id, r.status, r.signup_enabled, r.country_code,
         COALESCE(NULLIF(btrim(r.display_name), ''), r.name) AS display_name
  INTO v_region
  FROM public.regions r
  WHERE r.id = p_region_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'REGION_NOT_FOUND',
      'message', 'Selected driving region does not exist.'
    );
  END IF;
  IF v_region.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'REGION_DISABLED',
      'message', 'Selected driving region is not enabled.'
    );
  END IF;
  IF v_region.signup_enabled IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'REGION_NOT_SIGNUP_ENABLED',
      'message', 'Selected driving region is not available for signup.'
    );
  END IF;

  IF p_service_area_ids IS NULL OR cardinality(p_service_area_ids) < 1 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'SERVICE_AREA_REQUIRED',
      'message', 'Select at least one service area.'
    );
  END IF;

  FOREACH v_sa_id IN ARRAY p_service_area_ids LOOP
    SELECT sa.id, sa.is_active, sa.driver_signup_enabled, sa.region_id, sa.name
    INTO v_sa
    FROM public.service_areas sa
    WHERE sa.id = v_sa_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'SERVICE_AREA_NOT_FOUND',
        'message', 'A selected service area does not exist.'
      );
    END IF;
    IF v_sa.is_active IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'SERVICE_AREA_DISABLED',
        'message', format('Service area "%s" is not enabled.', v_sa.name)
      );
    END IF;
    IF v_sa.driver_signup_enabled IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'SERVICE_AREA_NOT_SIGNUP_ENABLED',
        'message', format('Service area "%s" is not available for signup.', v_sa.name)
      );
    END IF;
    -- HARD parent-child: never allow Area from Region B under Region A.
    IF v_sa.region_id IS DISTINCT FROM p_region_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'SERVICE_AREA_REGION_MISMATCH',
        'message', format(
          'Service area "%s" does not belong to the selected driving region.',
          v_sa.name
        )
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'region_id', v_region.id,
    'country_code', v_region.country_code,
    'service_area_ids', to_jsonb(p_service_area_ids)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO anon, authenticated, service_role;
