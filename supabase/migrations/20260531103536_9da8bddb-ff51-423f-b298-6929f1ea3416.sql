-- Replace global business_name unique with (business_name, service_area_id) scoped unique
DROP INDEX IF EXISTS public.merchants_business_name_unique_ci;

CREATE UNIQUE INDEX IF NOT EXISTS merchants_business_name_area_unique_ci
  ON public.merchants (lower(business_name), service_area_id);