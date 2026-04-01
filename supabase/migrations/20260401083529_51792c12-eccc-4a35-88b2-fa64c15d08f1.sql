
-- 1. Fix admin_settings: restrict SELECT to admins only
DROP POLICY IF EXISTS "Authenticated users can read settings" ON public.admin_settings;
CREATE POLICY "Admins can read settings" ON public.admin_settings
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 2. Fix invoices: drop blanket authenticated read policy (scoped policies already exist)
DROP POLICY IF EXISTS "Authenticated users can view invoices" ON public.invoices;

-- 3. Fix invoice_items: drop blanket authenticated read policy
DROP POLICY IF EXISTS "Authenticated users can view invoice items" ON public.invoice_items;

-- 4. Fix statement_schedule_configs: restrict write to admins only
DROP POLICY IF EXISTS "Authenticated users can create statement schedules" ON public.statement_schedule_configs;
DROP POLICY IF EXISTS "Authenticated users can update statement schedules" ON public.statement_schedule_configs;
DROP POLICY IF EXISTS "Authenticated users can view statement schedules" ON public.statement_schedule_configs;

CREATE POLICY "Admins can view statement schedules" ON public.statement_schedule_configs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can create statement schedules" ON public.statement_schedule_configs
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update statement schedules" ON public.statement_schedule_configs
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- 5. Fix user_directory: it's a view, so we need to secure it
-- Check if it has RLS or if we need to restrict the underlying view
-- Since user_directory is a view, we make it SECURITY INVOKER to respect underlying table RLS
ALTER VIEW IF EXISTS public.user_directory SET (security_invoker = true);
