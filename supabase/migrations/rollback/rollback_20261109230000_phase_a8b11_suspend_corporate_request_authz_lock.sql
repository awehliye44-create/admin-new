-- Rollback Phase A8B11. Restores the exact pre-change production body and safe ACL.
-- Does not update corporate_account_requests or corporate_accounts.
-- Production body_md5 before A8B11: 385220812ddc89518f6a3974132c2805

BEGIN;

CREATE OR REPLACE FUNCTION public.suspend_corporate_request(
  p_request_id uuid,
  p_reviewed_by uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  UPDATE corporate_account_requests
  SET status = 'suspended', suspended_at = now(), reviewed_at = now(),
      reviewed_by = p_reviewed_by, updated_at = now()
  WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
END;
$fn$;

COMMENT ON FUNCTION public.suspend_corporate_request(uuid, uuid) IS NULL;

REVOKE ALL ON FUNCTION public.suspend_corporate_request(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.suspend_corporate_request(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.suspend_corporate_request(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.suspend_corporate_request(uuid, uuid) TO service_role;

COMMIT;
