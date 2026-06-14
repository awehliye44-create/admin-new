
-- Phase 2: Sync staff_profiles changes into public.user_roles atomically.
-- Staff (any role) implies app_role='admin' for backend authorization.

CREATE OR REPLACE FUNCTION public.sync_staff_user_role(
  _target_user_id uuid,
  _action text  -- 'grant' or 'revoke'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _caller uuid := auth.uid();
  _is_admin boolean;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _caller AND role = 'admin'
  ) OR EXISTS (
    SELECT 1 FROM public.staff_profiles sp
    WHERE sp.user_id = _caller AND sp.is_active = true
      AND sp.role IN ('super_admin','admin')
  )
  INTO _is_admin;

  IF NOT _is_admin THEN
    RAISE EXCEPTION 'Forbidden: only admins can sync user_roles' USING ERRCODE = '42501';
  END IF;

  IF _target_user_id IS NULL THEN
    RAISE EXCEPTION 'target_user_id required';
  END IF;

  IF _action = 'grant' THEN
    INSERT INTO public.user_roles (user_id, role)
    VALUES (_target_user_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF _action = 'revoke' THEN
    DELETE FROM public.user_roles
    WHERE user_id = _target_user_id AND role = 'admin';
  ELSE
    RAISE EXCEPTION 'Invalid action: %', _action;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_staff_user_role(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.sync_staff_user_role(uuid, text) TO authenticated;

-- Backfill: every active staff_profile should have an 'admin' user_roles entry.
INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT sp.user_id, 'admin'::public.app_role
FROM public.staff_profiles sp
WHERE sp.is_active = true
ON CONFLICT (user_id, role) DO NOTHING;
