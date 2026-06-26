-- Admin driver financial summaries — bypass drivers column REVOKE + RLS for staff admins.
-- driver_financial_summary uses security_invoker and joins drivers (email/phone/stripe revoked
-- from authenticated). Payouts & Ledger Audit and Driver Wallet admin pages use this RPC.

CREATE OR REPLACE FUNCTION public.admin_driver_financial_summaries(
  p_region_id uuid DEFAULT NULL,
  p_driver_id uuid DEFAULT NULL
)
RETURNS SETOF public.driver_financial_summary
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT dfs.*
  FROM public.driver_financial_summary dfs
  WHERE (p_region_id IS NULL OR dfs.region_id = p_region_id)
    AND (p_driver_id IS NULL OR dfs.driver_id = p_driver_id)
  ORDER BY dfs.last_name NULLS LAST, dfs.first_name NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_driver_financial_summaries(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_driver_financial_summaries(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.admin_driver_financial_summaries(uuid, uuid) IS
  'Admin-only driver_financial_summary rows including PII columns revoked from direct authenticated SELECT on drivers.';
