-- =========================================================
-- ONECAB Roles & Permissions hardening
-- =========================================================

-- 1. Action-level permission table
CREATE TABLE IF NOT EXISTS public.role_action_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role public.staff_role NOT NULL,
  action_key text NOT NULL,
  is_allowed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, action_key)
);

GRANT SELECT ON public.role_action_permissions TO authenticated;
GRANT ALL ON public.role_action_permissions TO service_role;

ALTER TABLE public.role_action_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read action permissions"
  ON public.role_action_permissions FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = auth.uid() AND sp.is_active)
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
  );

-- writes only through SECURITY DEFINER rpcs / service role
CREATE POLICY "Service role manages action permissions"
  ON public.role_action_permissions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TRIGGER trg_role_action_permissions_updated_at
  BEFORE UPDATE ON public.role_action_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Seed capability keys
INSERT INTO public.role_action_permissions (role, action_key, is_allowed)
SELECT r.role, k.action_key,
       CASE
         WHEN r.role = 'super_admin' THEN true
         WHEN r.role = 'admin' AND k.action_key IN ('roles_permissions.view','roles_permissions.view_audit_log') THEN true
         ELSE false
       END
FROM (SELECT unnest(enum_range(NULL::public.staff_role)) AS role) r
CROSS JOIN (VALUES
  ('roles_permissions.view'),
  ('roles_permissions.create_role'),
  ('roles_permissions.edit_role'),
  ('roles_permissions.delete_role'),
  ('roles_permissions.assign_role'),
  ('roles_permissions.manage_permissions'),
  ('roles_permissions.assign_service_areas'),
  ('roles_permissions.view_audit_log')
) AS k(action_key)
ON CONFLICT (role, action_key) DO NOTHING;

-- 3. Identity helpers
CREATE OR REPLACE FUNCTION public.staff_role_of(_user_id uuid)
RETURNS public.staff_role
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT sp.role FROM public.staff_profiles sp
  WHERE sp.user_id = _user_id AND sp.is_active = true
  LIMIT 1
$$;

-- Legacy admin (user_roles admin with no staff profile) is treated as super_admin
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    CASE
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
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    public.is_super_admin(_user_id)
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

CREATE OR REPLACE FUNCTION public.active_super_admin_count()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT count(*)::int FROM public.staff_profiles
  WHERE role = 'super_admin' AND is_active = true
$$;

GRANT EXECUTE ON FUNCTION public.staff_role_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_super_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO authenticated;

-- 4. Audit helper
CREATE OR REPLACE FUNCTION public.log_roles_audit(
  _event_type text,
  _details jsonb
) RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO public.audit_logs (event_type, user_id, details)
  VALUES (
    _event_type,
    auth.uid(),
    _details || jsonb_build_object(
      'actor_role', COALESCE(public.staff_role_of(auth.uid())::text, 'legacy_admin'),
      'actor_is_super_admin', public.is_super_admin(auth.uid()),
      'source_page', 'roles-permissions',
      'logged_at', now()
    )
  )
$$;
GRANT EXECUTE ON FUNCTION public.log_roles_audit(text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_roles_action(
  _event_type text, _reason text, _details jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  PERFORM public.log_roles_audit(
    _event_type,
    COALESCE(_details, '{}'::jsonb) || jsonb_build_object('result', 'rejected', 'rejection_reason', _reason)
  );
  RAISE EXCEPTION '%', _reason USING ERRCODE = '42501';
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_roles_action(text, text, jsonb) TO authenticated;

-- =========================================================
-- 5. Mutation RPCs
-- =========================================================

-- 5a. page permission
CREATE OR REPLACE FUNCTION public.admin_set_role_page_permission(
  _role public.staff_role, _page_slug text, _can_access boolean, _correlation_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prev boolean;
  v_details jsonb := jsonb_build_object(
    'target_role', _role, 'page_slug', _page_slug,
    'new_access', _can_access, 'correlation_id', _correlation_id,
    'permission_keys_changed', jsonb_build_array('page:' || _page_slug)
  );
BEGIN
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.manage_permissions') THEN
    PERFORM public.reject_roles_action('roles.permission.toggle', 'You do not have permission to perform this action.', v_details);
  END IF;

  IF _role = 'super_admin' THEN
    PERFORM public.reject_roles_action('roles.permission.protected_attempt',
      'This Super Admin account is protected and cannot be changed by your role.', v_details);
  END IF;

  -- cannot grant a page you do not hold yourself
  IF _can_access AND NOT public.is_super_admin(auth.uid()) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.role_page_permissions rpp
      WHERE rpp.role = public.staff_role_of(auth.uid())
        AND rpp.page_slug = _page_slug AND rpp.can_access = true
    ) THEN
      PERFORM public.reject_roles_action('roles.permission.toggle',
        'You cannot grant a permission you do not have.', v_details);
    END IF;
  END IF;

  SELECT can_access INTO v_prev FROM public.role_page_permissions
   WHERE role = _role AND page_slug = _page_slug;

  INSERT INTO public.role_page_permissions (role, page_slug, can_access)
  VALUES (_role, _page_slug, _can_access)
  ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access, updated_at = now();

  PERFORM public.log_roles_audit('roles.permission.toggle',
    v_details || jsonb_build_object('previous_access', v_prev, 'result', 'success'));
END;
$$;

-- 5b. action permission
CREATE OR REPLACE FUNCTION public.admin_set_role_action_permission(
  _role public.staff_role, _action_key text, _is_allowed boolean, _correlation_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prev boolean;
  v_details jsonb := jsonb_build_object(
    'target_role', _role, 'action_key', _action_key, 'new_value', _is_allowed,
    'correlation_id', _correlation_id,
    'permission_keys_changed', jsonb_build_array(_action_key)
  );
BEGIN
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.manage_permissions') THEN
    PERFORM public.reject_roles_action('roles.action_permission.toggle',
      'You do not have permission to perform this action.', v_details);
  END IF;

  IF _role = 'super_admin' THEN
    PERFORM public.reject_roles_action('roles.permission.protected_attempt',
      'This Super Admin account is protected and cannot be changed by your role.', v_details);
  END IF;

  IF _is_allowed AND NOT public.staff_has_action(auth.uid(), _action_key) THEN
    PERFORM public.reject_roles_action('roles.action_permission.toggle',
      'You cannot grant a permission you do not have.', v_details);
  END IF;

  SELECT is_allowed INTO v_prev FROM public.role_action_permissions
   WHERE role = _role AND action_key = _action_key;

  INSERT INTO public.role_action_permissions (role, action_key, is_allowed)
  VALUES (_role, _action_key, _is_allowed)
  ON CONFLICT (role, action_key) DO UPDATE SET is_allowed = EXCLUDED.is_allowed, updated_at = now();

  PERFORM public.log_roles_audit('roles.action_permission.toggle',
    v_details || jsonb_build_object('previous_value', v_prev, 'result', 'success'));
END;
$$;

-- 5c. create staff
CREATE OR REPLACE FUNCTION public.admin_create_staff_member(
  _user_id uuid, _full_name text, _username text, _role public.staff_role,
  _service_area_ids uuid[] DEFAULT '{}', _correlation_id text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_details jsonb := jsonb_build_object(
    'target_user_id', _user_id, 'full_name', _full_name, 'role', _role,
    'service_areas_added', to_jsonb(_service_area_ids), 'correlation_id', _correlation_id
  );
BEGIN
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.create_role') THEN
    PERFORM public.reject_roles_action('roles.staff.add', 'You do not have permission to perform this action.', v_details);
  END IF;

  IF _role = 'super_admin' AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.super_admin_promote_attempt',
      'Only an existing Super Admin can grant the Super Admin role.', v_details);
  END IF;

  IF array_length(_service_area_ids, 1) > 0
     AND NOT public.staff_has_action(auth.uid(), 'roles_permissions.assign_service_areas') THEN
    PERFORM public.reject_roles_action('roles.staff.add',
      'You do not have permission to assign service areas.', v_details);
  END IF;

  INSERT INTO public.staff_profiles (user_id, full_name, username, role, staff_role_id, created_by)
  VALUES (_user_id, _full_name, NULLIF(_username, ''), _role, 'TEMP', auth.uid())
  RETURNING id INTO v_id;

  IF array_length(_service_area_ids, 1) > 0 THEN
    INSERT INTO public.staff_service_areas (staff_id, service_area_id)
    SELECT v_id, unnest(_service_area_ids);
  END IF;

  PERFORM public.log_roles_audit('roles.staff.add',
    v_details || jsonb_build_object('target_staff_id', v_id, 'result', 'success'));
  RETURN v_id;
END;
$$;

-- 5d. update staff (name/username/service areas)
CREATE OR REPLACE FUNCTION public.admin_update_staff_member(
  _staff_id uuid, _full_name text, _username text,
  _service_area_ids uuid[] DEFAULT '{}', _correlation_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.staff_profiles%ROWTYPE;
  v_before jsonb;
  v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  v_before := jsonb_build_object(
    'full_name', v_row.full_name, 'username', v_row.username, 'role', v_row.role,
    'service_area_ids', (SELECT COALESCE(jsonb_agg(service_area_id), '[]'::jsonb)
                           FROM public.staff_service_areas WHERE staff_id = _staff_id));
  v_details := jsonb_build_object(
    'target_staff_id', _staff_id, 'target_user_id', v_row.user_id,
    'previous_values', v_before,
    'new_values', jsonb_build_object('full_name', _full_name, 'username', _username,
                                     'service_area_ids', to_jsonb(_service_area_ids)),
    'correlation_id', _correlation_id);

  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.edit_role') THEN
    PERFORM public.reject_roles_action('roles.staff.edit', 'You do not have permission to perform this action.', v_details);
  END IF;

  IF v_row.role = 'super_admin' AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt',
      'This Super Admin account is protected and cannot be changed by your role.', v_details);
  END IF;

  UPDATE public.staff_profiles
     SET full_name = _full_name, username = NULLIF(_username, ''), updated_at = now()
   WHERE id = _staff_id;

  IF public.staff_has_action(auth.uid(), 'roles_permissions.assign_service_areas') THEN
    DELETE FROM public.staff_service_areas WHERE staff_id = _staff_id;
    IF array_length(_service_area_ids, 1) > 0 THEN
      INSERT INTO public.staff_service_areas (staff_id, service_area_id)
      SELECT _staff_id, unnest(_service_area_ids);
    END IF;
  END IF;

  PERFORM public.log_roles_audit('roles.staff.edit', v_details || jsonb_build_object('result', 'success'));
END;
$$;

-- 5e. reassign role
CREATE OR REPLACE FUNCTION public.admin_assign_staff_role(
  _staff_id uuid, _new_role public.staff_role, _correlation_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.staff_profiles%ROWTYPE;
  v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  v_details := jsonb_build_object(
    'target_staff_id', _staff_id, 'target_user_id', v_row.user_id,
    'previous_values', jsonb_build_object('role', v_row.role),
    'new_values', jsonb_build_object('role', _new_role),
    'correlation_id', _correlation_id);

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

-- 5f. suspend / activate
CREATE OR REPLACE FUNCTION public.admin_set_staff_active(
  _staff_id uuid, _is_active boolean, _correlation_id text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row public.staff_profiles%ROWTYPE;
  v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;

  v_details := jsonb_build_object(
    'target_staff_id', _staff_id, 'target_user_id', v_row.user_id, 'full_name', v_row.full_name,
    'role', v_row.role,
    'previous_values', jsonb_build_object('is_active', v_row.is_active),
    'new_values', jsonb_build_object('is_active', _is_active),
    'correlation_id', _correlation_id);

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

-- 5g. remove staff
CREATE OR REPLACE FUNCTION public.admin_remove_staff_member(
  _staff_id uuid, _correlation_id text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
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
    'correlation_id', _correlation_id);

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

GRANT EXECUTE ON FUNCTION public.admin_set_role_page_permission(public.staff_role, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_role_action_permission(public.staff_role, text, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_staff_member(uuid, text, text, public.staff_role, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_staff_member(uuid, text, text, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_staff_role(uuid, public.staff_role, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_staff_active(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_remove_staff_member(uuid, text) TO authenticated;

-- =========================================================
-- 6. Lock down direct client writes (RPC-only mutations)
-- =========================================================
DROP POLICY IF EXISTS "Role permissions insert by admin" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Role permissions update by admin" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Role permissions delete by admin" ON public.role_page_permissions;

DROP POLICY IF EXISTS "Staff profiles insert by admin" ON public.staff_profiles;
DROP POLICY IF EXISTS "Staff profiles update by admin" ON public.staff_profiles;
DROP POLICY IF EXISTS "Staff profiles delete by admin" ON public.staff_profiles;

DROP POLICY IF EXISTS "Staff service areas insert by admin" ON public.staff_service_areas;
DROP POLICY IF EXISTS "Staff service areas update by admin" ON public.staff_service_areas;
DROP POLICY IF EXISTS "Staff service areas delete by admin" ON public.staff_service_areas;

REVOKE INSERT, UPDATE, DELETE ON public.role_page_permissions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.staff_profiles FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.staff_service_areas FROM authenticated;

GRANT ALL ON public.role_page_permissions TO service_role;
GRANT ALL ON public.staff_profiles TO service_role;
GRANT ALL ON public.staff_service_areas TO service_role;

-- Full staff directory remains readable to staff for the page listing
DROP POLICY IF EXISTS "Staff profiles viewable by admin or self" ON public.staff_profiles;
CREATE POLICY "Staff profiles viewable by staff or self"
  ON public.staff_profiles FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'admin'::public.app_role)
  );
