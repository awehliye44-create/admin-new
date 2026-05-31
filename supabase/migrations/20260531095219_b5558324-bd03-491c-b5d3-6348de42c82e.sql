GRANT SELECT ON public.offers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.offers TO authenticated;
GRANT ALL ON public.offers TO service_role;

GRANT SELECT ON public.offer_service_areas TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.offer_service_areas TO authenticated;
GRANT ALL ON public.offer_service_areas TO service_role;

GRANT SELECT, INSERT ON public.offer_redemptions TO authenticated;
GRANT ALL ON public.offer_redemptions TO service_role;