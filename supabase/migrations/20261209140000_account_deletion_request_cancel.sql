-- Account deletion requests: let the user cancel their own pending request.
--
-- Cancelling closes the pending (open/waiting) account_deletion conversation
-- for the caller's own profile, tags it 'cancelled_by_user' and leaves a
-- system note for Admin. Nothing about the account changes: no deactivation,
-- no sign-out. The partial unique indexes only cover open/waiting rows, so a
-- new request can be filed afterwards.
--
-- Once Admin has completed the deletion the profile is detached from Auth
-- (user_id = NULL, deleted_at set), so the caller no longer resolves to a
-- profile and cancellation is refused.

CREATE OR REPLACE FUNCTION public.cancel_account_deletion_request(p_app text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_profile_id uuid;
  v_conversation_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_app = 'customer' THEN
    SELECT c.id INTO v_profile_id
    FROM public.customers c
    WHERE c.user_id = v_user_id
      AND c.deleted_at IS NULL
      AND c.rider_status <> 'deleted'
    LIMIT 1;
  ELSIF p_app = 'driver' THEN
    SELECT d.id INTO v_profile_id
    FROM public.drivers d
    WHERE d.user_id = v_user_id
      AND d.deleted_at IS NULL
    LIMIT 1;
  ELSE
    RAISE EXCEPTION 'invalid_app' USING ERRCODE = '22023';
  END IF;

  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'account_deletion_not_cancellable' USING ERRCODE = 'P0002';
  END IF;

  SELECT sc.id INTO v_conversation_id
  FROM public.support_conversations sc
  WHERE sc.category = 'account_deletion'
    AND sc.status IN ('open', 'waiting')
    AND (
      (p_app = 'customer' AND sc.customer_id = v_profile_id)
      OR (p_app = 'driver' AND sc.driver_id = v_profile_id)
    )
  ORDER BY sc.created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- Nothing pending (already cancelled, or Admin already resolved it).
  IF v_conversation_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.support_conversations
  SET status = 'closed',
      resolved_at = now(),
      tags = array_append(array_remove(COALESCE(tags, '{}'::text[]), 'cancelled_by_user'), 'cancelled_by_user')
  WHERE id = v_conversation_id;

  INSERT INTO public.support_messages (conversation_id, sender_type, sender_id, content, content_type, metadata)
  VALUES (
    v_conversation_id,
    'system',
    NULL,
    'The user cancelled this account deletion request in the app. No account changes were made.',
    'system',
    jsonb_build_object(
      'request_type', 'account_deletion',
      'action', 'cancelled',
      'cancellation_reason', 'cancelled_by_user',
      'app', p_app,
      'profile_id', v_profile_id
    )
  );

  RETURN v_conversation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_account_deletion_request(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_account_deletion_request(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_account_deletion_request(text) TO authenticated;

COMMENT ON FUNCTION public.cancel_account_deletion_request(text) IS
  'Signed-in Customer/Driver cancels their own pending account_deletion request (closed, tagged cancelled_by_user, system note). Returns the conversation id, or NULL when nothing is pending. Refused once Admin has completed the deletion.';
