-- Rollback Phase A2. Restores the exact pre-change body and ACL.
-- Does not update corporate_accounts.

BEGIN;

CREATE OR REPLACE FUNCTION public.reactivate_corporate_account(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  UPDATE corporate_accounts
  SET status = 'active', updated_at = now()
  WHERE id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.reactivate_corporate_account(uuid) IS NULL;

REVOKE ALL ON FUNCTION public.reactivate_corporate_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reactivate_corporate_account(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.reactivate_corporate_account(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_corporate_account(uuid) TO service_role;

COMMIT;
