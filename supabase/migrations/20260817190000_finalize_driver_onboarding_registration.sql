-- Idempotent Driver onboarding finalisation (Auth user → drivers + DSA + vehicle).
-- Hardens the existing Create Account → verify → contract path. Do not deploy
-- until explicitly approved. Client keeps RLS/RPC writers until this is live.

CREATE OR REPLACE FUNCTION public.finalize_driver_onboarding_registration(
  p_first_name text,
  p_last_name text,
  p_residential_address text,
  p_postcode text,
  p_city text,
  p_country text,
  p_region_id uuid,
  p_service_area_ids uuid[],
  p_vehicle_make text,
  p_vehicle_model text,
  p_vehicle_year integer,
  p_vehicle_color text,
  p_license_plate text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text;
  v_email_confirmed timestamptz;
  v_phone_confirmed timestamptz;
  v_driver_id uuid;
  v_driver_user uuid;
  v_vehicle_id uuid;
  v_area uuid;
  v_primary uuid;
  v_plate text;
  v_validation jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT
    u.email,
    u.phone,
    u.email_confirmed_at,
    u.phone_confirmed_at
  INTO v_email, v_phone, v_email_confirmed, v_phone_confirmed
  FROM auth.users u
  WHERE u.id = v_uid;

  IF v_email_confirmed IS NULL THEN
    RAISE EXCEPTION 'EMAIL_UNVERIFIED' USING ERRCODE = '42501';
  END IF;
  IF v_phone_confirmed IS NULL OR coalesce(v_phone, '') = '' THEN
    RAISE EXCEPTION 'PHONE_UNVERIFIED' USING ERRCODE = '42501';
  END IF;

  IF p_region_id IS NULL THEN
    RAISE EXCEPTION 'REGION_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_service_area_ids IS NULL OR cardinality(p_service_area_ids) = 0 THEN
    RAISE EXCEPTION 'SERVICE_AREAS_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_primary := p_service_area_ids[1];
  v_plate := upper(regexp_replace(trim(p_license_plate), '\s+', ' ', 'g'));

  SELECT id, user_id
  INTO v_driver_id, v_driver_user
  FROM public.drivers
  WHERE user_id = v_uid
    AND deleted_at IS NULL
  LIMIT 1;

  IF v_driver_id IS NOT NULL AND v_driver_user IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'DRIVER_OWNERSHIP_CONFLICT' USING ERRCODE = '42501';
  END IF;

  IF v_driver_id IS NULL THEN
    INSERT INTO public.drivers (
      user_id,
      first_name,
      last_name,
      phone,
      email,
      region_id,
      service_area_id,
      residential_address,
      postcode,
      city,
      country,
      phone_verified,
      email_verified,
      onboarding_complete
    )
    VALUES (
      v_uid,
      left(trim(p_first_name), 80),
      left(trim(p_last_name), 80),
      CASE WHEN v_phone LIKE '+%' THEN v_phone ELSE '+' || v_phone END,
      lower(trim(v_email)),
      p_region_id,
      v_primary,
      nullif(left(trim(p_residential_address), 240), ''),
      nullif(upper(left(trim(p_postcode), 32)), ''),
      nullif(left(trim(p_city), 80), ''),
      nullif(left(trim(p_country), 80), ''),
      true,
      true,
      false
    )
    ON CONFLICT (user_id) DO UPDATE
      SET first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          region_id = EXCLUDED.region_id,
          service_area_id = COALESCE(public.drivers.service_area_id, EXCLUDED.service_area_id),
          residential_address = COALESCE(EXCLUDED.residential_address, public.drivers.residential_address),
          postcode = COALESCE(EXCLUDED.postcode, public.drivers.postcode),
          city = COALESCE(EXCLUDED.city, public.drivers.city),
          country = COALESCE(EXCLUDED.country, public.drivers.country)
    RETURNING id INTO v_driver_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.drivers d
    WHERE d.id = v_driver_id AND d.user_id IS DISTINCT FROM v_uid
  ) THEN
    RAISE EXCEPTION 'DRIVER_OWNERSHIP_CONFLICT' USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_validation := public.validate_driver_signup_region_service_areas(p_region_id, p_service_area_ids);
    IF v_validation IS NOT NULL
       AND (
         coalesce((v_validation->>'ok')::boolean, true) = false
         OR coalesce((v_validation->>'valid')::boolean, true) = false
       )
    THEN
      RAISE EXCEPTION 'SERVICE_AREA_INVALID' USING ERRCODE = '22023';
    END IF;
  EXCEPTION
    WHEN undefined_function THEN
      NULL;
  END;

  FOREACH v_area IN ARRAY p_service_area_ids
  LOOP
    INSERT INTO public.driver_service_areas (driver_id, service_area_id)
    VALUES (v_driver_id, v_area)
    ON CONFLICT (driver_id, service_area_id) DO NOTHING;
  END LOOP;

  SELECT v.id
  INTO v_vehicle_id
  FROM public.vehicles v
  WHERE v.driver_id = v_driver_id
  ORDER BY v.is_primary DESC
  LIMIT 1;

  IF v_vehicle_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.vehicles other
      WHERE upper(regexp_replace(trim(other.license_plate), '\s+', ' ', 'g')) = v_plate
        AND other.driver_id IS DISTINCT FROM v_driver_id
    ) THEN
      RAISE EXCEPTION 'VEHICLE_OWNERSHIP_CONFLICT' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.vehicles (
      driver_id, make, model, year, color, license_plate, is_primary
    )
    VALUES (
      v_driver_id,
      trim(p_vehicle_make),
      trim(p_vehicle_model),
      p_vehicle_year,
      trim(p_vehicle_color),
      v_plate,
      true
    )
    RETURNING id INTO v_vehicle_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', v_driver_id,
    'vehicle_id', v_vehicle_id,
    'service_area_ids', to_jsonb(p_service_area_ids),
    'onboarding_complete', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(
  text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(
  text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text
) TO authenticated;
