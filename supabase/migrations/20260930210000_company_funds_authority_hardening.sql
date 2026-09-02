-- Company funds authority hardening — reserve policy writes via edge/service-role only.
BEGIN;

CREATE OR REPLACE FUNCTION public.staff_has_company_funds_read_access(p_page_slug text DEFAULT 'payout-ledger')
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_profiles sp
    JOIN public.role_page_permissions rpp
      ON rpp.role = sp.role::text
     AND rpp.page_slug = p_page_slug
     AND rpp.can_access = true
    WHERE sp.user_id = auth.uid()
      AND sp.is_active = true
      AND sp.role::text = ANY (ARRAY['super_admin', 'admin', 'finance_manager']::text[])
  );
$$;

REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO service_role;

-- Remove broad authenticated write on reserve tables.
DROP POLICY IF EXISTS company_ops_reserve_admin_all ON public.company_operational_refund_reserves;
DROP POLICY IF EXISTS company_ops_reserve_audit_admin_all ON public.company_operational_reserve_audit;

CREATE POLICY company_ops_reserve_finance_read
  ON public.company_operational_refund_reserves
  FOR SELECT
  TO authenticated
  USING (public.staff_has_company_funds_read_access('payout-ledger'));

CREATE POLICY company_ops_reserve_audit_finance_read
  ON public.company_operational_reserve_audit
  FOR SELECT
  TO authenticated
  USING (public.staff_has_company_funds_read_access('payout-ledger'));

-- service_role retains full access (edge functions).
-- No INSERT/UPDATE/DELETE policies for authenticated on reserve tables.

COMMENT ON FUNCTION public.staff_has_company_funds_read_access IS
  'Finance/admin payout-ledger readers only. Mutations route through admin-company-operational-reserve edge.';

COMMIT;
