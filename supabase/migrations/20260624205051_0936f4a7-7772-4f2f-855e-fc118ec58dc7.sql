
DROP VIEW IF EXISTS public.merchants_public;

CREATE VIEW public.merchants_public
WITH (security_invoker = false) AS
SELECT
  id, business_name, category, service_area_id, description,
  address, city, postcode, logo_url, banner_url, opening_hours,
  is_open, prep_time_minutes, delivery_radius_km, min_order_amount,
  status, created_at, updated_at
FROM public.merchants
WHERE status = 'approved'::merchant_status;

GRANT SELECT ON public.merchants_public TO anon, authenticated;
