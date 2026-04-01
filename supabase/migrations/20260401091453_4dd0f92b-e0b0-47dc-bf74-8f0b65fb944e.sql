CREATE OR REPLACE FUNCTION public.lost_property_admin_unread_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::integer FROM public.lost_property_cases
  WHERE status NOT IN ('CLOSED')
  AND (
    status = 'NEW'
    OR (status = 'SENT_TO_DRIVER' AND admin_viewed_at IS NULL)
    OR (status = 'ESCALATED' AND admin_viewed_at IS NULL)
    OR (admin_last_read_message_at IS NULL AND EXISTS (
      SELECT 1 FROM public.lost_property_messages m
      WHERE m.case_id = lost_property_cases.id AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
    ))
    OR (admin_last_read_message_at IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.lost_property_messages m
      WHERE m.case_id = lost_property_cases.id AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
      AND m.created_at > lost_property_cases.admin_last_read_message_at
    ))
  );
$$;