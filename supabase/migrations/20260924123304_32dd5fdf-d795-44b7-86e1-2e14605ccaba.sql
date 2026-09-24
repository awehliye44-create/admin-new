-- Helpers (fixed search_path, SECURITY DEFINER to avoid RLS recursion)
CREATE OR REPLACE FUNCTION public.is_platform_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.has_role(auth.uid(), 'admin'::app_role) OR public.is_super_admin(auth.uid())
  )
$$;

CREATE OR REPLACE FUNCTION public.is_platform_member()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.drivers d WHERE d.user_id = auth.uid() AND d.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.customers c WHERE c.user_id = auth.uid())
    OR public.is_platform_staff()
  )
$$;

CREATE OR REPLACE FUNCTION public.is_active_service_area(_service_area_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.service_areas sa WHERE sa.id = _service_area_id AND sa.is_active = true)
$$;

REVOKE ALL ON FUNCTION public.is_platform_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_platform_member() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_service_area(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_platform_member() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_service_area(uuid) TO authenticated, service_role;

-- regions
DROP POLICY IF EXISTS "Authenticated can read all regions" ON public.regions;
CREATE POLICY "Staff read all regions" ON public.regions FOR SELECT TO authenticated USING (public.is_platform_staff());
CREATE POLICY "Members read active regions" ON public.regions FOR SELECT TO authenticated
  USING (status = 'active' AND public.is_platform_member());

-- service_areas
DROP POLICY IF EXISTS "Authenticated can read all service areas" ON public.service_areas;
CREATE POLICY "Staff read all service areas" ON public.service_areas FOR SELECT TO authenticated USING (public.is_platform_staff());
CREATE POLICY "Members read active service areas" ON public.service_areas FOR SELECT TO authenticated
  USING (is_active = true AND public.is_platform_member());

-- service_area_payment_methods
DROP POLICY IF EXISTS "Authenticated can read payment methods" ON public.service_area_payment_methods;
CREATE POLICY "Members read active area payment methods" ON public.service_area_payment_methods FOR SELECT TO authenticated
  USING (public.is_platform_member() AND public.is_active_service_area(service_area_id));

-- stop_waiting_settings
DROP POLICY IF EXISTS "stop_waiting_settings auth read" ON public.stop_waiting_settings;
CREATE POLICY "Members read active area stop waiting settings" ON public.stop_waiting_settings FOR SELECT TO authenticated
  USING (public.is_platform_member() AND public.is_active_service_area(service_area_id));

-- service_area_sequences: staff only
DROP POLICY IF EXISTS "Authenticated users can view sequences" ON public.service_area_sequences;
CREATE POLICY "Staff read sequences" ON public.service_area_sequences FOR SELECT TO authenticated USING (public.is_platform_staff());

-- service_area_customer_identity_settings
DROP POLICY IF EXISTS "Customers read customer identity settings" ON public.service_area_customer_identity_settings;
CREATE POLICY "Members read active area identity settings" ON public.service_area_customer_identity_settings FOR SELECT TO authenticated
  USING (public.is_platform_member() AND public.is_active_service_area(service_area_id));

-- offer_service_areas
DROP POLICY IF EXISTS "offer_sa_read" ON public.offer_service_areas;
CREATE POLICY "Members read active area offer links" ON public.offer_service_areas FOR SELECT TO authenticated
  USING (public.is_platform_member() AND public.is_active_service_area(service_area_id));

-- preset_offers
DROP POLICY IF EXISTS "Anyone can read preset offers" ON public.preset_offers;
CREATE POLICY "Staff read preset offers" ON public.preset_offers FOR SELECT TO authenticated USING (public.is_platform_staff());
CREATE POLICY "Members read active preset offers" ON public.preset_offers FOR SELECT TO authenticated
  USING (is_active = true AND public.is_platform_member());

-- service_area_marketplace_settings
DROP POLICY IF EXISTS "Anyone read service area marketplace settings" ON public.service_area_marketplace_settings;
CREATE POLICY "Members read active area marketplace settings" ON public.service_area_marketplace_settings FOR SELECT TO authenticated
  USING (public.is_platform_member() AND public.is_active_service_area(service_area_id));

-- service_area_merchant_settings
DROP POLICY IF EXISTS "Public can read sa merchant settings" ON public.service_area_merchant_settings;
CREATE POLICY "Members read active area merchant settings" ON public.service_area_merchant_settings FOR SELECT TO authenticated
  USING (public.is_platform_member() AND public.is_active_service_area(service_area_id));

-- merchant_categories
DROP POLICY IF EXISTS "Public can read merchant categories" ON public.merchant_categories;
CREATE POLICY "Staff read merchant categories" ON public.merchant_categories FOR SELECT TO authenticated USING (public.is_platform_staff());
CREATE POLICY "Members read enabled merchant categories" ON public.merchant_categories FOR SELECT TO authenticated
  USING (enabled = true AND public.is_platform_member());

-- merchant_product_categories
DROP POLICY IF EXISTS "Public read product categories" ON public.merchant_product_categories;
CREATE POLICY "Members read product categories" ON public.merchant_product_categories FOR SELECT TO authenticated
  USING (public.is_platform_member());

-- location_search_rollout
DROP POLICY IF EXISTS "Anyone can read location search rollout" ON public.location_search_rollout;
CREATE POLICY "Members read location search rollout" ON public.location_search_rollout FOR SELECT TO authenticated
  USING (public.is_platform_member());

-- ai_credit_packages / settings
DROP POLICY IF EXISTS "packages readable by all" ON public.ai_credit_packages;
CREATE POLICY "Staff read ai credit packages" ON public.ai_credit_packages FOR SELECT TO authenticated USING (public.is_platform_staff());
CREATE POLICY "Members read active ai credit packages" ON public.ai_credit_packages FOR SELECT TO authenticated
  USING (active = true AND public.is_platform_member());
DROP POLICY IF EXISTS "settings readable by all" ON public.ai_credit_settings;
CREATE POLICY "Members read ai credit settings" ON public.ai_credit_settings FOR SELECT TO authenticated
  USING (public.is_platform_member());

-- app_performance_baselines: staff only
DROP POLICY IF EXISTS "apb_authenticated_select" ON public.app_performance_baselines;
CREATE POLICY "apb_staff_select" ON public.app_performance_baselines FOR SELECT TO authenticated USING (public.is_platform_staff());

-- Storage: driver statement PDFs bound to caller
DROP POLICY IF EXISTS "Drivers read own statement PDFs" ON storage.objects;
CREATE POLICY "Drivers read own statement PDFs" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'driver-statement-pdfs'
    AND (
      EXISTS (
        SELECT 1 FROM public.drivers d
        WHERE d.user_id = (SELECT auth.uid())
          AND d.id::text = (storage.foldername(name))[1]
      )
      OR public.is_platform_staff()
    )
  );

-- Storage: merchant assets stay downloadable via public URL, but not listable
DROP POLICY IF EXISTS "Public read merchant assets" ON storage.objects;