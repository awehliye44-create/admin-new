-- Admin Trip History reads the latest invoice email log for the Invoice column.
-- Customers must not read the outbox. Service role remains the writer.

DROP POLICY IF EXISTS invoice_email_outbox_admin_select ON public.invoice_email_outbox;

CREATE POLICY invoice_email_outbox_admin_select
  ON public.invoice_email_outbox
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'
    )
    OR EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active IS TRUE
    )
  );
