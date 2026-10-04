-- Account deletion requests: one pending request per role profile, and session
-- revocation for Admin when a deletion is completed.
--
-- Customer and Driver apps file an `account_deletion` support conversation.
-- A pending request is status 'open' or 'waiting'. Once Admin resolves or
-- closes it, the user may file a new one.
--
-- Customer and driver profiles are separate role profiles, so a person with
-- both may have one pending request per app.

CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_one_pending_deletion_per_customer
  ON public.support_conversations (customer_id)
  WHERE category = 'account_deletion'
    AND status IN ('open', 'waiting')
    AND customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_one_pending_deletion_per_driver
  ON public.support_conversations (driver_id)
  WHERE category = 'account_deletion'
    AND status IN ('open', 'waiting')
    AND driver_id IS NOT NULL;

COMMENT ON INDEX public.support_conversations_one_pending_deletion_per_customer IS
  'At most one pending (open/waiting) account_deletion request per customer profile. Apps treat 23505 as "already submitted".';
COMMENT ON INDEX public.support_conversations_one_pending_deletion_per_driver IS
  'At most one pending (open/waiting) account_deletion request per driver profile. Apps treat 23505 as "already submitted".';

-- Signs a user out of every device: removing auth.sessions cascades to
-- auth.refresh_tokens, so no session can be refreshed and getUser() fails.
-- Service role only; called by admin-delete-account after a completed deletion.
CREATE OR REPLACE FUNCTION public.admin_revoke_user_sessions(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_revoked integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  DELETE FROM auth.sessions WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;
  RETURN v_revoked;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_user_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_revoke_user_sessions(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_sessions(uuid) TO service_role;

COMMENT ON FUNCTION public.admin_revoke_user_sessions(uuid) IS
  'Service role only. Revokes every auth session (and refresh token) for a user after Admin completes an account deletion.';
