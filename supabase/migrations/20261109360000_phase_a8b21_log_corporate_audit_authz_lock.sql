-- ============================================================
-- Phase A8B21: log_corporate_audit body authorization lock
-- NOT APPLIED until explicitly approved.
--
-- Target: public.log_corporate_audit(
--   p_corporate_account_id uuid,
--   p_action text,
--   p_action_type text,
--   p_target_type text DEFAULT NULL,
--   p_target_id text DEFAULT NULL,
--   p_target_name text DEFAULT NULL,
--   p_metadata jsonb DEFAULT NULL
-- ) RETURNS uuid
-- Baseline body_md5:  189b2b510f1aefb10b115aea3e6a3d0f
-- Proposed body_md5:  9d2aaa16834baa880931cd49b43553de
--
-- Vulnerability: SECURITY DEFINER insert with no account/action
--   authorization. Actor is already auth.uid(), but any authenticated
--   caller can write audit rows for any corporate_account_id and forge
--   arbitrary action labels. corporate_audit_log has SELECT-only RLS;
--   this RPC bypasses table INSERT policies.
--
-- Proven authenticated Corporate Portal callers
-- (onecab-central-hub/src/hooks/useCorporate.ts):
--   Employee Added / create / employee     → can_write_corporate
--   Employee Removed / delete / employee   → can_write_corporate
--   Location Added / create / location     → can_write_corporate
--   Support Ticket Created / create / ticket → has_corporate_access
-- Gates match the underlying table RLS for those mutations.
-- No Admin / Driver / Customer / Guest / Edge / SQL parent / RLS /
--   trigger / cron / view callers.
--
-- Remediation (NEEDS_BODY_AUTHORIZATION — decision C):
--   - Keep actor = auth.uid() (no caller-supplied actor id)
--   - Require authenticated JWT (uid NOT NULL)
--   - Allowlist the four proven (action, action_type, target_type) tuples
--   - Admin-shaped events → can_write_corporate(uid, account)
--   - Support ticket event → has_corporate_access(uid, account)
--   - Reject unknown actions (viewers cannot forge admin audit events)
--   - Bound metadata to 4096 bytes when present
--   - Preserve signature/defaults/return/owner/plpgsql/VOLATILE/
--     SECURITY DEFINER/search_path=public and baseline ACL
--   - No current_user exception; no service-role bypass (no Edge caller)
--   - No new page/action slug; finance parent untouched
--
-- Residual integrity limitation (intentionally out of scope):
--   This phase authorizes who may append each event class. It does NOT prove
--   that the client-described mutation occurred. Do not add unsupported
--   target-existence checks (would break post-delete Employee Removed).
--   Future improvement: atomic mutation + audit RPCs.
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: unchanged 110
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.log_corporate_audit(
  p_corporate_account_id uuid,
  p_action text,
  p_action_type text,
  p_target_type text DEFAULT NULL::text,
  p_target_id text DEFAULT NULL::text,
  p_target_name text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_audit_id uuid;
  v_uid uuid := auth.uid();
  v_allowed boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_corporate_account_id IS NULL
     OR COALESCE(btrim(p_action), '') = ''
     OR COALESCE(btrim(p_action_type), '') = '' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_metadata IS NOT NULL AND octet_length(p_metadata::text) > 4096 THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF (p_action, p_action_type, COALESCE(p_target_type, '')) IN (
       ('Employee Added', 'create', 'employee'),
       ('Employee Removed', 'delete', 'employee'),
       ('Location Added', 'create', 'location')
     ) THEN
    v_allowed := public.can_write_corporate(v_uid, p_corporate_account_id);
  ELSIF (p_action, p_action_type, COALESCE(p_target_type, '')) =
        ('Support Ticket Created', 'create', 'ticket') THEN
    v_allowed := public.has_corporate_access(v_uid, p_corporate_account_id);
  ELSE
    v_allowed := false;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.corporate_audit_log (
    corporate_account_id, user_id, action, action_type,
    target_type, target_id, target_name, metadata
  ) VALUES (
    p_corporate_account_id, v_uid, p_action, p_action_type,
    p_target_type, p_target_id, p_target_name, p_metadata
  ) RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO service_role;

COMMIT;
