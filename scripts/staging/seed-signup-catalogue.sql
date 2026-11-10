-- Synthetic catalogue for Driver Create Account on LOCAL / non-prod only.
-- No production PII. Safe to re-run (idempotent on stable names/codes).
-- Includes a tiny GeoJSON polygon so validate_service_area_boundary passes.

BEGIN;

INSERT INTO public.regions (
  name,
  status,
  country_code,
  display_name,
  display_order,
  signup_enabled,
  distance_unit,
  currency_code,
  timezone
)
SELECT
  'QA England',
  'active',
  'GB',
  'QA England',
  0,
  true,
  'mile',
  'GBP',
  'Europe/London'
WHERE NOT EXISTS (
  SELECT 1 FROM public.regions WHERE name = 'QA England'
);

-- Rough box around Milton Keynes (synthetic QA boundary only).
WITH poly AS (
  SELECT '{
    "type":"Polygon",
    "coordinates":[[
      [-0.82,52.00],
      [-0.68,52.00],
      [-0.68,52.08],
      [-0.82,52.08],
      [-0.82,52.00]
    ]]
  }'::jsonb AS geo
)
INSERT INTO public.service_areas (
  name,
  region_id,
  is_active,
  driver_signup_enabled,
  trip_id_prefix,
  driver_id_prefix,
  code,
  display_order,
  geo_boundary
)
SELECT
  'QA Milton Keynes',
  r.id,
  true,
  true,
  'QMK',
  'QDRV',
  'QA_MK',
  0,
  poly.geo
FROM public.regions r
CROSS JOIN poly
WHERE r.name = 'QA England'
  AND NOT EXISTS (
    SELECT 1 FROM public.service_areas sa WHERE sa.code = 'QA_MK'
  );

WITH poly AS (
  SELECT '{
    "type":"Polygon",
    "coordinates":[[
      [-0.90,51.95],
      [-0.85,51.95],
      [-0.85,52.00],
      [-0.90,52.00],
      [-0.90,51.95]
    ]]
  }'::jsonb AS geo
)
INSERT INTO public.service_areas (
  name,
  region_id,
  is_active,
  driver_signup_enabled,
  trip_id_prefix,
  driver_id_prefix,
  code,
  display_order,
  geo_boundary
)
SELECT
  'QA Test Area',
  r.id,
  true,
  true,
  'QTA',
  'QTST',
  'QA_TEST',
  1,
  poly.geo
FROM public.regions r
CROSS JOIN poly
WHERE r.name = 'QA England'
  AND NOT EXISTS (
    SELECT 1 FROM public.service_areas sa WHERE sa.code = 'QA_TEST'
  );

INSERT INTO public.otp_allowed_countries (country_code, country_name, is_enabled)
SELECT 'GB', 'United Kingdom', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.otp_allowed_countries WHERE country_code = 'GB'
);

-- +447911111111 (local test OTP) parses as Guernsey (GG) in libphonenumber — allow for local QA only.
INSERT INTO public.otp_allowed_countries (country_code, country_name, is_enabled)
SELECT 'GG', 'Guernsey (local QA test OTP)', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.otp_allowed_countries WHERE country_code = 'GG'
);

COMMIT;

SELECT r.name AS region, r.signup_enabled, sa.name AS area, sa.driver_signup_enabled, sa.code
FROM public.regions r
JOIN public.service_areas sa ON sa.region_id = r.id
WHERE r.name = 'QA England'
ORDER BY sa.display_order;

SELECT country_code, is_enabled FROM public.otp_allowed_countries ORDER BY 1;
