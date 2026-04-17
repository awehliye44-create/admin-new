-- =============================================================
-- SECURITY FIXES BUNDLE
-- =============================================================

-- ─── 1. Fix lost_property_cases broken RLS (auth.uid() compared to customers.id) ───
DROP POLICY IF EXISTS "Customers can view their own cases" ON public.lost_property_cases;
DROP POLICY IF EXISTS "Customers can create cases for their trips" ON public.lost_property_cases;
DROP POLICY IF EXISTS "Customers can update their own cases" ON public.lost_property_cases;

CREATE POLICY "Customers can view their own cases"
  ON public.lost_property_cases FOR SELECT TO authenticated
  USING (customer_id = public.current_customer_id());

CREATE POLICY "Customers can create cases for their trips"
  ON public.lost_property_cases FOR INSERT TO authenticated
  WITH CHECK (customer_id = public.current_customer_id());

CREATE POLICY "Customers can update their own cases"
  ON public.lost_property_cases FOR UPDATE TO authenticated
  USING (customer_id = public.current_customer_id());

-- ─── 2. Fix lost_property_messages broken RLS ───
DROP POLICY IF EXISTS "Case participants can view messages" ON public.lost_property_messages;
DROP POLICY IF EXISTS "Participants can send messages" ON public.lost_property_messages;

CREATE POLICY "Case participants can view messages"
  ON public.lost_property_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.lost_property_cases lpc
      WHERE lpc.id = case_id
        AND (
          lpc.customer_id = public.current_customer_id()
          OR lpc.driver_id = public.current_driver_profile_id()
          OR public.has_role(auth.uid(), 'admin'::public.app_role)
        )
    )
  );

CREATE POLICY "Participants can send messages"
  ON public.lost_property_messages FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.lost_property_cases lpc
      WHERE lpc.id = case_id
        AND (
          lpc.customer_id = public.current_customer_id()
          OR lpc.driver_id = public.current_driver_profile_id()
          OR public.has_role(auth.uid(), 'admin'::public.app_role)
        )
    )
  );

-- ─── 3. Fix storage policy for LP photos ───
DROP POLICY IF EXISTS "LP photos viewable by case participants" ON storage.objects;
CREATE POLICY "LP photos viewable by case participants"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'lost-property-photos'
    AND EXISTS (
      SELECT 1 FROM public.lost_property_cases lpc
      WHERE (storage.foldername(name))[1] = lpc.id::text
        AND (
          lpc.customer_id = public.current_customer_id()
          OR lpc.driver_id = public.current_driver_profile_id()
          OR public.has_role(auth.uid(), 'admin'::public.app_role)
        )
    )
  );

-- ─── 4. Restrict corporate_fare_rules: remove unscoped read ───
DROP POLICY IF EXISTS "Anyone can read active corporate fare rules" ON public.corporate_fare_rules;
DROP POLICY IF EXISTS "Authenticated can read active corporate fare rules" ON public.corporate_fare_rules;

-- Admins keep full access via the existing "Admins can manage corporate fare rules" policy.
-- Allow corporate members to see only rules for their own corporate_account
CREATE POLICY "Corporate members read own fare rules"
  ON public.corporate_fare_rules FOR SELECT TO authenticated
  USING (
    is_active = true
    AND corporate_account_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.corporate_user_accounts cua
      WHERE cua.corporate_account_id = corporate_fare_rules.corporate_account_id
        AND cua.user_id = auth.uid()
    )
  );

-- ─── 5. Lock down user_directory PII view ───
-- Revoke broad access; only service_role and admins via has_role wrapper should read it.
REVOKE ALL ON public.user_directory FROM anon, authenticated;
GRANT SELECT ON public.user_directory TO service_role;

-- Provide a SECURITY INVOKER admin-gated wrapper function so admin UI can keep calling it
CREATE OR REPLACE FUNCTION public.admin_user_directory()
RETURNS SETOF public.user_directory
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.user_directory
  WHERE public.has_role(auth.uid(), 'admin'::public.app_role);
$$;

REVOKE ALL ON FUNCTION public.admin_user_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO authenticated;