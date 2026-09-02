-- Close Create Account launch gaps:
-- 1) Authenticated drivers must not forge terms_* (including first write).
-- 2) finalize_driver_onboarding_registration may write terms via session GUC.
-- 3) Grandfather existing drivers with NULL terms so resume/confirm stays safe.
--
-- Does not overwrite non-null acceptance timestamps.

BEGIN;

-- ---------------------------------------------------------------------------
-- Privileged guard: Terms writes only when allow-flag set (finalize) or admin
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_driver_privileged_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_allow_terms text := coalesce(current_setting('onecab.allow_driver_terms_write', true), '');
BEGIN
  IF public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = OLD.user_id THEN
    IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.onboarding_complete IS DISTINCT FROM OLD.onboarding_complete THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.documents_approved IS DISTINCT FROM OLD.documents_approved THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.is_online IS DISTINCT FROM OLD.is_online THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.driver_online_intent IS DISTINCT FROM OLD.driver_online_intent THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF NEW.driver_status IS DISTINCT FROM OLD.driver_status THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;

    -- Terms: client may never set or change; finalize sets local GUC first.
    IF v_allow_terms IS DISTINCT FROM '1'
       AND (
         NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at
         OR NEW.terms_version IS DISTINCT FROM OLD.terms_version
       )
    THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- finalize: arm Terms write flag for this transaction
-- ---------------------------------------------------------------------------

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
  p_license_plate text,
  p_terms_version text
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
  v_terms_version text := nullif(trim(p_terms_version), '');
  v_terms_key text := 'terms';
  v_make text := nullif(trim(p_vehicle_make), '');
  v_model text := nullif(trim(p_vehicle_model), '');
  v_color text := nullif(trim(p_vehicle_color), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  IF v_terms_version IS NULL THEN
    RAISE EXCEPTION 'TERMS_ACCEPTANCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  -- Allow this SECURITY DEFINER body to stamp terms_* for the caller.
  PERFORM set_config('onecab.allow_driver_terms_write', '1', true);

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

  IF v_make IS NULL OR v_model IS NULL OR v_color IS NULL THEN
    RAISE EXCEPTION 'VEHICLE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_vehicle_year IS NULL OR p_vehicle_year < 1980 OR p_vehicle_year > 2100 THEN
    RAISE EXCEPTION 'VEHICLE_YEAR_INVALID' USING ERRCODE = '22023';
  END IF;

  v_primary := p_service_area_ids[1];
  v_plate := upper(regexp_replace(trim(coalesce(p_license_plate, '')), '\s+', ' ', 'g'));
  IF v_plate IS NULL OR length(v_plate) < 2 THEN
    RAISE EXCEPTION 'VEHICLE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  v_validation := public.validate_driver_signup_region_service_areas(p_region_id, p_service_area_ids);
  IF v_validation IS NOT NULL
     AND (
       coalesce((v_validation->>'ok')::boolean, true) = false
       OR coalesce((v_validation->>'valid')::boolean, true) = false
     )
  THEN
    RAISE EXCEPTION 'SERVICE_AREA_INVALID' USING ERRCODE = '22023';
  END IF;

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
      onboarding_complete,
      terms_accepted_at,
      terms_version
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
      false,
      now(),
      v_terms_version
    )
    ON CONFLICT (user_id) DO UPDATE
      SET first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          region_id = EXCLUDED.region_id,
          service_area_id = COALESCE(public.drivers.service_area_id, EXCLUDED.service_area_id),
          residential_address = COALESCE(EXCLUDED.residential_address, public.drivers.residential_address),
          postcode = COALESCE(EXCLUDED.postcode, public.drivers.postcode),
          city = COALESCE(EXCLUDED.city, public.drivers.city),
          country = COALESCE(EXCLUDED.country, public.drivers.country),
          terms_accepted_at = COALESCE(public.drivers.terms_accepted_at, EXCLUDED.terms_accepted_at),
          terms_version = COALESCE(public.drivers.terms_version, EXCLUDED.terms_version)
    RETURNING id INTO v_driver_id;
  ELSE
    UPDATE public.drivers d
    SET
      first_name = left(trim(p_first_name), 80),
      last_name = left(trim(p_last_name), 80),
      region_id = p_region_id,
      service_area_id = COALESCE(d.service_area_id, v_primary),
      residential_address = COALESCE(nullif(left(trim(p_residential_address), 240), ''), d.residential_address),
      postcode = COALESCE(nullif(upper(left(trim(p_postcode), 32)), ''), d.postcode),
      city = COALESCE(nullif(left(trim(p_city), 80), ''), d.city),
      country = COALESCE(nullif(left(trim(p_country), 80), ''), d.country),
      terms_accepted_at = COALESCE(d.terms_accepted_at, now()),
      terms_version = COALESCE(d.terms_version, v_terms_version)
    WHERE d.id = v_driver_id
      AND d.user_id = v_uid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.drivers d
    WHERE d.id = v_driver_id AND d.user_id IS DISTINCT FROM v_uid
  ) THEN
    RAISE EXCEPTION 'DRIVER_OWNERSHIP_CONFLICT' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.drivers d
    WHERE d.id = v_driver_id
      AND d.terms_accepted_at IS NOT NULL
      AND nullif(trim(d.terms_version), '') IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'TERMS_ACCEPTANCE_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.driver_legal_acceptances (
    user_id, driver_id, document_key, document_version, accepted_at
  )
  VALUES (v_uid, v_driver_id, v_terms_key, v_terms_version, now())
  ON CONFLICT (user_id, document_key, document_version) DO NOTHING;

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
  ORDER BY v.is_primary DESC NULLS LAST
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
      v_make,
      v_model,
      p_vehicle_year,
      v_color,
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
    'onboarding_complete', false,
    'terms_version', (
      SELECT d.terms_version FROM public.drivers d WHERE d.id = v_driver_id
    ),
    'terms_accepted_at', (
      SELECT d.terms_accepted_at FROM public.drivers d WHERE d.id = v_driver_id
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(
  text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(
  text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text
) TO authenticated;

-- ---------------------------------------------------------------------------
-- Grandfather existing rows (NULL only — never overwrite prior acceptance)
-- ---------------------------------------------------------------------------

UPDATE public.drivers d
SET
  terms_accepted_at = coalesce(d.created_at, now()),
  terms_version = 'grandfather_pre_driver_terms_v1'
WHERE d.deleted_at IS NULL
  AND d.terms_accepted_at IS NULL
  AND nullif(trim(coalesce(d.terms_version, '')), '') IS NULL;

INSERT INTO public.driver_legal_acceptances (
  user_id, driver_id, document_key, document_version, accepted_at
)
SELECT
  d.user_id,
  d.id,
  'terms',
  'grandfather_pre_driver_terms_v1',
  d.terms_accepted_at
FROM public.drivers d
WHERE d.deleted_at IS NULL
  AND d.user_id IS NOT NULL
  AND d.terms_version = 'grandfather_pre_driver_terms_v1'
ON CONFLICT (user_id, document_key, document_version) DO NOTHING;

COMMIT;
