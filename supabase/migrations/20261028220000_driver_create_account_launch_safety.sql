-- Driver Create Account launch safety:
-- 1) Versioned Terms acceptance (backend SSOT)
-- 2) Single finalize writer (revoke client drivers INSERT)
-- 3) Protect privileged driver columns from self-UPDATE
--
-- Does not change dispatch / trip / wallet behaviour beyond registration security.

BEGIN;

-- ---------------------------------------------------------------------------
-- Terms acceptance columns + audit table
-- ---------------------------------------------------------------------------

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS terms_version text NULL;

COMMENT ON COLUMN public.drivers.terms_accepted_at IS
  'First Terms acceptance timestamp. Never overwritten on re-finalise.';
COMMENT ON COLUMN public.drivers.terms_version IS
  'Terms document version accepted at first registration finalise.';

CREATE TABLE IF NOT EXISTS public.driver_legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  driver_id uuid NULL REFERENCES public.drivers (id) ON DELETE SET NULL,
  document_key text NOT NULL,
  document_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_legal_acceptances_doc_nonempty
    CHECK (length(trim(document_key)) > 0 AND length(trim(document_version)) > 0),
  CONSTRAINT driver_legal_acceptances_unique_version
    UNIQUE (user_id, document_key, document_version)
);

CREATE INDEX IF NOT EXISTS idx_driver_legal_acceptances_user
  ON public.driver_legal_acceptances (user_id, document_key);

ALTER TABLE public.driver_legal_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Drivers read own legal acceptances"
  ON public.driver_legal_acceptances;
CREATE POLICY "Drivers read own legal acceptances"
  ON public.driver_legal_acceptances
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins read all legal acceptances"
  ON public.driver_legal_acceptances;
CREATE POLICY "Admins read all legal acceptances"
  ON public.driver_legal_acceptances
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- No INSERT/UPDATE/DELETE for authenticated — only SECURITY DEFINER writers.

REVOKE ALL ON TABLE public.driver_legal_acceptances FROM PUBLIC;
GRANT SELECT ON TABLE public.driver_legal_acceptances TO authenticated;

-- ---------------------------------------------------------------------------
-- Protect privileged columns on self-update (Home/eligibility must stay backend)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_driver_privileged_column_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;
  -- service_role / SECURITY DEFINER callers with no JWT still pass when auth.uid() is null
  -- only if they are not a normal authenticated self-update. Block authenticated drivers.
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
    -- Terms: never let client overwrite first acceptance timestamp / version.
    IF OLD.terms_accepted_at IS NOT NULL
       AND NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
    IF OLD.terms_version IS NOT NULL
       AND NEW.terms_version IS DISTINCT FROM OLD.terms_version THEN
      RAISE EXCEPTION 'DRIVER_PRIVILEGED_FIELD_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drivers_privileged_column_guard ON public.drivers;
CREATE TRIGGER trg_drivers_privileged_column_guard
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_driver_privileged_column_guard();

-- ---------------------------------------------------------------------------
-- Single SSOT writer: revoke client drivers INSERT (finalize is SECURITY DEFINER)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Users can create own driver profile" ON public.drivers;
DROP POLICY IF EXISTS "Users can create their own driver profile" ON public.drivers;

-- ---------------------------------------------------------------------------
-- Replace finalize RPC — Terms required; no client fallback path
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.finalize_driver_onboarding_registration(
  text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text
);

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

  -- Area validation is mandatory (no silent skip).
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
          -- Never overwrite an existing first acceptance.
          terms_accepted_at = COALESCE(public.drivers.terms_accepted_at, EXCLUDED.terms_accepted_at),
          terms_version = COALESCE(public.drivers.terms_version, EXCLUDED.terms_version)
    RETURNING id INTO v_driver_id;
  ELSE
    -- Existing partial registration: set Terms only if missing.
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

COMMENT ON FUNCTION public.finalize_driver_onboarding_registration(
  text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text
) IS
  'SSOT Driver registration finalise: verified Auth + Terms + areas + vehicle. Idempotent. No client drivers INSERT.';

COMMIT;
