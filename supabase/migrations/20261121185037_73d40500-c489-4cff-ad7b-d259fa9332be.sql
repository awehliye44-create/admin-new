CREATE OR REPLACE FUNCTION public.current_approved_driver_id()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  select d.id
  from public.drivers d
  where d.user_id = auth.uid()
    and d.approval_status = 'approved'
    and d.deleted_at is null
    and coalesce(d.driver_status::text, 'active') <> 'deleted'
  limit 1
$$;

REVOKE EXECUTE ON FUNCTION public.current_approved_driver_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_approved_driver_id() TO authenticated, service_role;

DROP POLICY IF EXISTS "Drivers can view own invoices" ON public.invoices;
CREATE POLICY "Drivers can view own invoices"
  ON public.invoices FOR SELECT TO authenticated
  USING (driver_id = public.current_approved_driver_id());

DROP POLICY IF EXISTS "Drivers can view own invoice items" ON public.invoice_items;
CREATE POLICY "Drivers can view own invoice items"
  ON public.invoice_items FOR SELECT TO authenticated
  USING (invoice_id IN (
    SELECT i.id FROM public.invoices i
    WHERE i.driver_id = public.current_approved_driver_id()
  ));

DROP POLICY IF EXISTS "Drivers can view own statements" ON public.driver_statements;
CREATE POLICY "Drivers can view own statements"
  ON public.driver_statements FOR SELECT TO authenticated
  USING (driver_id = public.current_approved_driver_id());