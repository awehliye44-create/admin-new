
-- 1. Exactly one owner, race-safe
CREATE UNIQUE INDEX IF NOT EXISTS staff_profiles_single_owner_uq ON public.staff_profiles ((true)) WHERE is_owner;
CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_catalog_single_owner_role_uq ON public.staff_roles_catalog ((true)) WHERE is_owner_role;

-- 2. Owner role may only be held by the owner account
CREATE OR REPLACE FUNCTION public.enforce_owner_role_holder()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner_role boolean;
BEGIN
  SELECT is_owner_role INTO v_owner_role FROM public.staff_roles_catalog WHERE id = NEW.role_id;
  IF v_owner_role AND NOT NEW.is_owner THEN
    RAISE EXCEPTION 'OWNER_PROTECTED: Super Admin is reserved for the ONECAB Owner.' USING ERRCODE = '42501';
  END IF;
  IF NEW.is_owner AND NOT coalesce(v_owner_role,false) THEN
    RAISE EXCEPTION 'OWNER_PROTECTED: the Owner must keep the Super Admin role.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_owner_role_holder() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS tr_enforce_owner_role_holder ON public.staff_profiles;
CREATE TRIGGER tr_enforce_owner_role_holder BEFORE INSERT OR UPDATE OF role_id, is_owner ON public.staff_profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_owner_role_holder();

-- 3. Super admin == owner identity (no role-name or legacy admin-flag path)
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND _user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = _user_id AND sp.is_owner AND sp.is_active)
$$;

-- 4. Staff/role management actions are owner-only and never delegable
CREATE OR REPLACE FUNCTION public.staff_has_action(_user_id uuid, _action_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_owner(_user_id)
    OR (
      _action_key NOT LIKE 'roles_permissions.%'
      AND EXISTS (SELECT 1 FROM public.staff_profiles sp
               JOIN public.staff_roles_catalog c ON c.id = sp.role_id AND c.is_active
               JOIN public.role_action_permissions rap ON rap.role_id = sp.role_id
               WHERE sp.user_id = _user_id AND sp.is_active AND rap.action_key = _action_key AND rap.is_allowed)
    )
$$;

CREATE OR REPLACE FUNCTION public.staff_has_page_access(p_page_slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(p_page_slug,'') <> '' AND (
    public.is_owner(auth.uid())
    OR (p_page_slug <> 'roles' AND EXISTS (
      SELECT 1 FROM public.staff_profiles sp
      JOIN public.staff_roles_catalog c ON c.id = sp.role_id AND c.is_active
      JOIN public.role_page_permissions rpp ON rpp.role_id = sp.role_id AND rpp.page_slug = p_page_slug AND rpp.can_access
      WHERE sp.user_id = auth.uid() AND sp.is_active)))
$$;

CREATE OR REPLACE FUNCTION public.staff_can_manage_roles(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_owner(_user_id)
$$;

-- strip non-delegable grants from every non-owner role
DELETE FROM public.role_page_permissions rpp USING public.staff_roles_catalog c
 WHERE c.id = rpp.role_id AND NOT c.is_owner_role AND rpp.page_slug = 'roles';
DELETE FROM public.role_action_permissions rap USING public.staff_roles_catalog c
 WHERE c.id = rap.role_id AND NOT c.is_owner_role AND rap.action_key LIKE 'roles_permissions.%';

-- block re-granting at the table level
CREATE OR REPLACE FUNCTION public.block_non_delegable_permissions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner boolean;
BEGIN
  SELECT is_owner_role INTO v_owner FROM public.staff_roles_catalog WHERE id = NEW.role_id;
  IF coalesce(v_owner,false) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'role_page_permissions' AND NEW.page_slug = 'roles' AND NEW.can_access THEN
    RAISE EXCEPTION 'Roles & Permissions is reserved for the ONECAB Owner.' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'role_action_permissions' AND NEW.action_key LIKE 'roles_permissions.%' AND NEW.is_allowed THEN
    RAISE EXCEPTION 'Staff management permissions are reserved for the ONECAB Owner.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.block_non_delegable_permissions() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER tr_block_non_delegable_page BEFORE INSERT OR UPDATE ON public.role_page_permissions
  FOR EACH ROW EXECUTE FUNCTION public.block_non_delegable_permissions();
CREATE TRIGGER tr_block_non_delegable_action BEFORE INSERT OR UPDATE ON public.role_action_permissions
  FOR EACH ROW EXECUTE FUNCTION public.block_non_delegable_permissions();

-- 5. admin login flag sync: owner only
CREATE OR REPLACE FUNCTION public.sync_staff_user_role(_target_user_id uuid, _action text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_owner(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden: only the ONECAB Owner can change admin access' USING ERRCODE = '42501';
  END IF;
  IF _target_user_id IS NULL THEN RAISE EXCEPTION 'target_user_id required'; END IF;
  IF _action = 'grant' THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id = _target_user_id AND is_active) THEN
      RAISE EXCEPTION 'Only active staff members can be given admin access' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.user_roles (user_id, role) VALUES (_target_user_id, 'admin') ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF _action = 'revoke' THEN
    IF public.is_owner(_target_user_id) THEN
      RAISE EXCEPTION 'OWNER_PROTECTED: the Owner keeps admin access' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.user_roles WHERE user_id = _target_user_id AND role = 'admin';
  ELSE
    RAISE EXCEPTION 'Invalid action: %', _action;
  END IF;
END $$;

-- 6. user_roles: admins can no longer mint/remove the admin role directly
DROP POLICY IF EXISTS "Admins can insert roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins can delete roles" ON public.user_roles;
CREATE POLICY "Admins can insert non-admin roles; owner any" ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::public.app_role) AND (role <> 'admin'::public.app_role OR public.is_owner(auth.uid())));
CREATE POLICY "Admins can delete non-admin roles; owner any" ON public.user_roles FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::public.app_role) AND (role <> 'admin'::public.app_role OR (public.is_owner(auth.uid()) AND NOT public.is_owner(user_id))));

-- 7. staff/permission audit history: owner only
CREATE POLICY "Roles audit visible to owner only" ON public.audit_logs AS RESTRICTIVE FOR SELECT TO authenticated
  USING (event_type NOT LIKE 'roles.%' OR public.is_owner(auth.uid()));
