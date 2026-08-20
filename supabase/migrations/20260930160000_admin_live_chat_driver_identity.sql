-- Narrow Admin Live Chat driver identity RPC.
-- Production authenticated role has no SELECT on public.drivers (intentional).
-- Live Chat must not embed drivers in PostgREST, and this RPC is the only
-- authorized enrichment path for driver-app conversations.

CREATE OR REPLACE FUNCTION public.admin_live_chat_driver_identity(p_ids uuid[])
RETURNS TABLE (
  id uuid,
  first_name text,
  last_name text,
  driver_code text,
  phone text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin'::public.app_role) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT d.id, d.first_name, d.last_name, d.driver_code, d.phone
  FROM public.drivers d
  WHERE d.id = ANY (COALESCE(p_ids, ARRAY[]::uuid[]));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_live_chat_driver_identity(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_live_chat_driver_identity(uuid[]) TO authenticated;
