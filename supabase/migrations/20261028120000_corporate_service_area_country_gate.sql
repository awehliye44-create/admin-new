-- Corporate service-area country gate.
-- Country SSOT is regions.country_code. Currency SSOT is regions.currency_code.
-- Corporate rows may store a resolved ISO country_code; they must not attach
-- a service area from a different country.

ALTER TABLE public.corporate_accounts
  ADD COLUMN IF NOT EXISTS country_code text;

ALTER TABLE public.corporate_account_requests
  ADD COLUMN IF NOT EXISTS country_code text;

ALTER TABLE public.corporate_accounts
  DROP CONSTRAINT IF EXISTS corporate_accounts_country_code_chk;
ALTER TABLE public.corporate_accounts
  ADD CONSTRAINT corporate_accounts_country_code_chk
  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

ALTER TABLE public.corporate_account_requests
  DROP CONSTRAINT IF EXISTS corporate_account_requests_country_code_chk;
ALTER TABLE public.corporate_account_requests
  ADD CONSTRAINT corporate_account_requests_country_code_chk
  CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

COMMENT ON COLUMN public.corporate_accounts.country_code IS
  'ISO 3166-1 alpha-2 resolved from the company address/postcode. Must match service_areas.region.country_code.';
COMMENT ON COLUMN public.corporate_account_requests.country_code IS
  'ISO 3166-1 alpha-2 resolved from the company address/postcode at submission.';

UPDATE public.corporate_accounts ca
SET country_code = upper(btrim(r.country_code))
FROM public.service_areas sa
JOIN public.regions r ON r.id = sa.region_id
WHERE ca.service_area_id = sa.id
  AND ca.country_code IS NULL
  AND r.country_code ~ '^[A-Za-z]{2}$';

UPDATE public.corporate_account_requests req
SET country_code = upper(btrim(r.country_code))
FROM public.service_areas sa
JOIN public.regions r ON r.id = sa.region_id
WHERE req.service_area_id = sa.id
  AND req.country_code IS NULL
  AND r.country_code ~ '^[A-Za-z]{2}$';

CREATE OR REPLACE FUNCTION public.get_corporate_service_areas_for_country(
  p_country_code text,
  p_latitude double precision DEFAULT NULL,
  p_longitude double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_country text;
  v_rows jsonb;
BEGIN
  v_country := upper(btrim(coalesce(p_country_code, '')));
  IF v_country = 'UK' THEN
    v_country := 'GB';
  END IF;
  IF v_country !~ '^[A-Z]{2}$' THEN
    RETURN jsonb_build_object('country_code', NULL, 'service_areas', '[]'::jsonb);
  END IF;

  SELECT coalesce(
    jsonb_agg(to_jsonb(t) ORDER BY t.sort_distance_m NULLS LAST, t.name),
    '[]'::jsonb
  )
  INTO v_rows
  FROM (
    SELECT
      sa.id,
      sa.name,
      sa.code,
      upper(btrim(r.country_code)) AS country_code,
      r.currency_code,
      sa.center_lat,
      sa.center_lng,
      CASE
        WHEN p_latitude IS NOT NULL
          AND p_longitude IS NOT NULL
          AND sa.center_lat IS NOT NULL
          AND sa.center_lng IS NOT NULL
        THEN public.haversine_meters(p_latitude, p_longitude, sa.center_lat, sa.center_lng)
        ELSE NULL
      END AS sort_distance_m
    FROM public.service_areas sa
    INNER JOIN public.regions r ON r.id = sa.region_id
    WHERE sa.is_active IS TRUE
      AND upper(btrim(r.country_code)) = v_country
  ) t;

  RETURN jsonb_build_object(
    'country_code', v_country,
    'service_areas', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_corporate_service_areas_for_country(text, double precision, double precision)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_corporate_service_areas_for_country(text, double precision, double precision)
  TO service_role;

CREATE OR REPLACE FUNCTION public.validate_service_area_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_region_id uuid;
  v_sa_country text;
  v_row_country text;
BEGIN
  IF NEW.service_area_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT sa.region_id, upper(btrim(r.country_code))
  INTO v_region_id, v_sa_country
  FROM public.service_areas sa
  INNER JOIN public.regions r ON r.id = sa.region_id
  WHERE sa.id = NEW.service_area_id
    AND sa.is_active IS TRUE;

  IF v_region_id IS NULL OR v_sa_country IS NULL THEN
    RAISE EXCEPTION 'Invalid or inactive service area: %', NEW.service_area_id;
  END IF;

  NEW.region_id := v_region_id;

  v_row_country := upper(btrim(coalesce(NEW.country_code, '')));
  IF v_row_country = 'UK' THEN
    v_row_country := 'GB';
  END IF;

  IF TG_TABLE_NAME = 'corporate_account_requests' THEN
    -- Fail closed: requests must send a resolved ISO country that matches the SA.
    -- Do not stamp country from the SA (that would re-open cross-country attach).
    IF v_row_country !~ '^[A-Z]{2}$' OR v_row_country IS DISTINCT FROM v_sa_country THEN
      RAISE EXCEPTION 'SERVICE_AREA_COUNTRY_MISMATCH';
    END IF;
    NEW.country_code := v_row_country;
  ELSE
    IF v_row_country ~ '^[A-Z]{2}$' THEN
      IF v_row_country IS DISTINCT FROM v_sa_country THEN
        RAISE EXCEPTION 'SERVICE_AREA_COUNTRY_MISMATCH';
      END IF;
      NEW.country_code := v_row_country;
    ELSE
      NEW.country_code := v_sa_country;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_service_area_on_corporate_accounts ON public.corporate_accounts;
CREATE TRIGGER validate_service_area_on_corporate_accounts
BEFORE INSERT OR UPDATE OF service_area_id, country_code ON public.corporate_accounts
FOR EACH ROW EXECUTE FUNCTION public.validate_service_area_reference();

DROP TRIGGER IF EXISTS validate_service_area_on_corporate_requests ON public.corporate_account_requests;
CREATE TRIGGER validate_service_area_on_corporate_requests
BEFORE INSERT OR UPDATE OF service_area_id, country_code ON public.corporate_account_requests
FOR EACH ROW EXECUTE FUNCTION public.validate_service_area_reference();

CREATE OR REPLACE FUNCTION public.set_corporate_account_service_area(
  p_corporate_account_id uuid,
  p_service_area_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing uuid;
  v_account_country text;
  v_sa_country text;
  v_region_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.corporate_user_accounts
    WHERE user_id = auth.uid()
      AND corporate_account_id = p_corporate_account_id
      AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Not authorised for this corporate account';
  END IF;

  SELECT upper(btrim(country_code)), service_area_id
  INTO v_account_country, v_existing
  FROM public.corporate_accounts
  WHERE id = p_corporate_account_id;

  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'Service area already set for this account';
  END IF;

  SELECT sa.region_id, upper(btrim(r.country_code))
  INTO v_region_id, v_sa_country
  FROM public.service_areas sa
  INNER JOIN public.regions r ON r.id = sa.region_id
  WHERE sa.id = p_service_area_id
    AND sa.is_active IS TRUE;

  IF v_region_id IS NULL THEN
    RAISE EXCEPTION 'Invalid or inactive service area';
  END IF;

  IF v_account_country = 'UK' THEN
    v_account_country := 'GB';
  END IF;

  IF v_account_country IS NULL OR v_account_country !~ '^[A-Z]{2}$'
     OR v_account_country IS DISTINCT FROM v_sa_country THEN
    RAISE EXCEPTION 'SERVICE_AREA_COUNTRY_MISMATCH';
  END IF;

  UPDATE public.corporate_accounts
  SET
    service_area_id = p_service_area_id,
    region_id = v_region_id,
    country_code = v_sa_country
  WHERE id = p_corporate_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_corporate_request(
  p_request_id uuid,
  p_reviewed_by uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request RECORD;
  v_account_id uuid;
BEGIN
  SELECT * INTO v_request FROM public.corporate_account_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_request.status = 'approved' THEN RAISE EXCEPTION 'Request already approved'; END IF;

  INSERT INTO public.corporate_accounts (
    company_name, contact_name, contact_email, contact_phone,
    address, city, country, country_code, tax_id, employee_count, notes,
    region_id, service_area_id, status
  ) VALUES (
    v_request.company_name, v_request.contact_name, v_request.contact_email, v_request.contact_phone,
    v_request.address, v_request.city, v_request.country, v_request.country_code, v_request.tax_id,
    v_request.employee_count, v_request.notes,
    v_request.region_id, v_request.service_area_id, 'active'
  ) RETURNING id INTO v_account_id;

  UPDATE public.corporate_account_requests
  SET status = 'approved', approved_at = now(), reviewed_at = now(),
      reviewed_by = p_reviewed_by, updated_at = now()
  WHERE id = p_request_id;

  RETURN v_account_id;
END;
$$;

DROP POLICY IF EXISTS "Authenticated users can submit account requests"
  ON public.corporate_account_requests;
REVOKE INSERT ON TABLE public.corporate_account_requests FROM authenticated;
