-- App Live Chat (channel = in_app): allow customers/drivers to close their own
-- conversations. Message insert/select already covered by existing policies.
-- Admin Close & notify uses service-role Edge (app-support-notify).

CREATE POLICY "Customers close own conversations"
  ON public.support_conversations
  FOR UPDATE
  TO authenticated
  USING (customer_id = public.current_customer_id() AND user_type = 'customer')
  WITH CHECK (
    customer_id = public.current_customer_id()
    AND user_type = 'customer'
    AND status IN ('open', 'waiting', 'resolved', 'closed')
  );

CREATE POLICY "Drivers close own conversations"
  ON public.support_conversations
  FOR UPDATE
  TO authenticated
  USING (driver_id = public.current_driver_id() AND user_type = 'driver')
  WITH CHECK (
    driver_id = public.current_driver_id()
    AND user_type = 'driver'
    AND status IN ('open', 'waiting', 'resolved', 'closed')
  );

COMMENT ON POLICY "Customers close own conversations" ON public.support_conversations IS
  'App Live Chat: signed-in customers may update status on their own in_app/support rows (e.g. end chat).';

COMMENT ON POLICY "Drivers close own conversations" ON public.support_conversations IS
  'App Live Chat: signed-in drivers may update status on their own in_app/support rows (e.g. end chat).';
