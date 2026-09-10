-- Rollback Phase A8B21. Restores exact pre-change production body and safe ACL.
-- Production body_md5 before A8B21: 189b2b510f1aefb10b115aea3e6a3d0f
-- Never GRANT PUBLIC or anon.

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
  v_audit_id UUID;
BEGIN
  INSERT INTO public.corporate_audit_log (
    corporate_account_id, user_id, action, action_type, 
    target_type, target_id, target_name, metadata
  ) VALUES (
    p_corporate_account_id, auth.uid(), p_action, p_action_type,
    p_target_type, p_target_id, p_target_name, p_metadata
  ) RETURNING id INTO v_audit_id;
  
  RETURN v_audit_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO service_role;

COMMIT;
