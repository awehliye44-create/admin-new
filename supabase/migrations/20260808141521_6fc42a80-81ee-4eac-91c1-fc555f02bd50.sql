-- 1. Owner column + single-owner guarantee
ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS staff_profiles_single_owner_idx
  ON public.staff_profiles ((true)) WHERE is_owner;

-- 2. Owner resolver
CREATE OR REPLACE FUNCTION public.is_owner(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_profiles sp
    WHERE sp.user_id = _user_id AND sp.is_owner = true
  )
$$;

REVOKE EXECUTE ON FUNCTION public.is_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_owner(uuid) TO authenticated, service_role;

-- 3. Owner is implicitly Super Admin / all actions
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    CASE
      WHEN public.is_owner(_user_id) THEN true
      WHEN EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = _user_id)
        THEN EXISTS (
          SELECT 1 FROM public.staff_profiles sp
          WHERE sp.user_id = _user_id AND sp.is_active = true AND sp.role = 'super_admin'
        )
      ELSE public.has_role(_user_id, 'admin'::public.app_role)
    END
$$;

CREATE OR REPLACE FUNCTION public.staff_has_action(_user_id uuid, _action_key text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    public.is_owner(_user_id)
    OR public.is_super_admin(_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      JOIN public.role_action_permissions rap ON rap.role = sp.role
      WHERE sp.user_id = _user_id
        AND sp.is_active = true
        AND rap.action_key = _action_key
        AND rap.is_allowed = true
    )
$$;

-- 4. Hard backend protection (applies to service_role and any direct SQL path)
CREATE OR REPLACE FUNCTION public.protect_owner_staff_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_owner_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_owner THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the ONECAB Owner account cannot be deleted.'
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_owner THEN
      SELECT EXISTS (SELECT 1 FROM public.staff_profiles WHERE is_owner) INTO v_owner_exists;
      IF v_owner_exists THEN
        RAISE EXCEPTION 'OWNER_PROTECTED: an ONECAB Owner already exists.'
          USING ERRCODE = '42501';
      END IF;
      NEW.role := 'super_admin';
      NEW.is_active := true;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.is_owner THEN
    IF NEW.is_owner IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the Owner designation cannot be removed.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.role IS DISTINCT FROM 'super_admin'::public.staff_role THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the Owner cannot be downgraded from Super Admin.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.is_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the Owner account cannot be deactivated or suspended.'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the Owner identity cannot be reassigned.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.is_owner THEN
    SELECT EXISTS (SELECT 1 FROM public.staff_profiles WHERE is_owner) INTO v_owner_exists;
    IF v_owner_exists THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: an ONECAB Owner already exists; ownership transfer requires a dedicated workflow.'
        USING ERRCODE = '42501';
    END IF;
    NEW.role := 'super_admin';
    NEW.is_active := true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_owner_staff_profile ON public.staff_profiles;
CREATE TRIGGER trg_protect_owner_staff_profile
  BEFORE INSERT OR UPDATE OR DELETE ON public.staff_profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_owner_staff_profile();

-- 5. RPC-level guards (audited denials + self-protection)
CREATE OR REPLACE FUNCTION public.admin_remove_staff_member(_staff_id uuid, _correlation_id text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.staff_profiles%ROWTYPE;
  v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  v_details := jsonb_build_object(
    'target_staff_id', _staff_id, 'target_user_id', v_row.user_id,
    'full_name', v_row.full_name, 'staff_role_id', v_row.staff_role_id, 'role', v_row.role,
    'is_owner', v_row.is_owner, 'correlation_id', _correlation_id);

  IF v_row.is_owner THEN
    PERFORM public.reject_roles_action('roles.owner.protected_attempt',
      'The ONECAB Owner account is protected and cannot be removed.', v_details);
  END IF;

  IF v_row.user_id = auth.uid() THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked',
      'You cannot remove your own staff account.', v_details);
  END IF;

  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.delete_role') THEN
    PERFORM public.reject_roles_action('roles.staff.remove', 'You do not have permission to perform this action.', v_details);
  END IF;

  IF v_row.role = 'super_admin' AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt',
      'This Super Admin account is protected and cannot be changed by your role.', v_details);
  END IF;

  IF v_row.role = 'super_admin' AND v_row.is_active AND public.active_super_admin_count() <= 1 THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt',
      'The last active Super Admin cannot be removed.', v_details);
  END IF;

  DELETE FROM public.staff_service_areas WHERE staff_id = _staff_id;
  DELETE FROM public.staff_profiles WHERE id = _staff_id;

  PERFORM public.log_roles_audit('roles.staff.remove', v_details || jsonb_build_object('result', 'success'));
  RETURN v_row.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_staff_active(_staff_id uuid, _is_active boolean, _correlation_id text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.staff_profiles%ROWTYPE;
  v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  v_details := jsonb_build_object(
    'target_staff_id', _staff_id, 'target_user_id', v_row.user_id, 'full_name', v_row.full_name,
    'role', v_row.role, 'is_owner', v_row.is_owner,
    'previous_values', jsonb_build_object('is_active', v_row.is_active),
    'new_values', jsonb_build_object('is_active', _is_active),
    'correlation_id', _correlation_id);

  IF v_row.is_owner AND _is_active = false THEN
    PERFORM public.reject_roles_action('roles.owner.protected_attempt',
      'The ONECAB Owner account cannot be deactivated or suspended.', v_details);
  END IF;

  IF v_row.user_id = auth.uid() AND _is_active = false THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked',
      'You cannot deactivate your own staff account.', v_details);
  END IF;

  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.edit_role') THEN
    PERFORM public.reject_roles_action('roles.staff.suspend', 'You do not have permission to perform this action.', v_details);
  END IF;

  IF v_row.role = 'super_admin' AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt',
      'This Super Admin account is protected and cannot be changed by your role.', v_details);
  END IF;

  IF v_row.role = 'super_admin' AND _is_active = false AND public.active_super_admin_count() <= 1 THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt',
      'The last active Super Admin cannot be disabled.', v_details);
  END IF;

  UPDATE public.staff_profiles SET is_active = _is_active, updated_at = now() WHERE id = _staff_id;

  PERFORM public.log_roles_audit(
    CASE WHEN _is_active THEN 'roles.staff.activate' ELSE 'roles.staff.suspend' END,
    v_details || jsonb_build_object('result', 'success'));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_assign_staff_role(_staff_id uuid, _new_role staff_role, _correlation_id text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row public.staff_profiles%ROWTYPE;
  v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  v_details := jsonb_build_object(
    'target_staff_id', _staff_id, 'target_user_id', v_row.user_id,
    'is_owner', v_row.is_owner,
    'previous_values', jsonb_build_object('role', v_row.role),
    'new_values', jsonb_build_object('role', _new_role),
    'correlation_id', _correlation_id);

  IF v_row.is_owner AND _new_role <> 'super_admin' THEN
    PERFORM public.reject_roles_action('roles.owner.protected_attempt',
      'The ONECAB Owner cannot be downgraded from Super Admin.', v_details);
  END IF;

  IF v_row.user_id = auth.uid() AND _new_role <> v_row.role THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked',
      'You cannot change your own role.', v_details);
  END IF;

  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.assign_role') THEN
    PERFORM public.reject_roles_action('roles.staff.reassign', 'You do not have permission to perform this action.', v_details);
  END IF;

  IF (_new_role = 'super_admin' OR v_row.role = 'super_admin')
     AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.super_admin_promote_attempt',
      'Only an existing Super Admin can grant or change the Super Admin role.', v_details);
  END IF;

  IF v_row.role = 'super_admin' AND _new_role <> 'super_admin'
     AND v_row.is_active AND public.active_super_admin_count() <= 1 THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt',
      'The last active Super Admin cannot be downgraded.', v_details);
  END IF;

  UPDATE public.staff_profiles SET role = _new_role, updated_at = now() WHERE id = _staff_id;

  PERFORM public.log_roles_audit(
    CASE WHEN _new_role = 'super_admin' THEN 'roles.staff.promote_super_admin' ELSE 'roles.staff.reassign' END,
    v_details || jsonb_build_object('result', 'success'));
END;
$$;