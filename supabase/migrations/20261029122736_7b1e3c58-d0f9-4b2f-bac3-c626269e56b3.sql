
CREATE TABLE public.staff_roles_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  base_role public.staff_role NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_owner_role boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_roles_catalog_name_uq ON public.staff_roles_catalog (lower(name));
GRANT SELECT ON public.staff_roles_catalog TO authenticated;
GRANT ALL ON public.staff_roles_catalog TO service_role;
ALTER TABLE public.staff_roles_catalog ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_staff_roles_catalog_updated_at BEFORE UPDATE ON public.staff_roles_catalog
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.staff_roles_catalog (role_key, name, base_role, is_system, is_owner_role, description) VALUES
 ('super_admin','Super Admin','super_admin',true,true,'Full access. Protected owner role.'),
 ('admin','Admin','admin',true,false,NULL),
 ('operator','Operator','operator',true,false,NULL),
 ('finance_manager','Finance Manager','finance_manager',true,false,NULL),
 ('customer_support','Customer Support','customer_support',true,false,NULL),
 ('compliance_officer','Compliance Officer','compliance_officer',true,false,NULL);

-- staff_profiles.role_id (SOT) ; role becomes derived base level
ALTER TABLE public.staff_profiles ADD COLUMN role_id uuid REFERENCES public.staff_roles_catalog(id);
UPDATE public.staff_profiles sp SET role_id = c.id FROM public.staff_roles_catalog c WHERE c.role_key = sp.role::text;
ALTER TABLE public.staff_profiles ALTER COLUMN role_id SET NOT NULL;
CREATE INDEX staff_profiles_role_id_idx ON public.staff_profiles(role_id);

CREATE OR REPLACE FUNCTION public.staff_profiles_derive_base_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT base_role INTO NEW.role FROM public.staff_roles_catalog WHERE id = NEW.role_id;
  IF NEW.role IS NULL THEN RAISE EXCEPTION 'Unknown staff role'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tr_00_staff_profiles_derive_base_role BEFORE INSERT OR UPDATE OF role_id, role ON public.staff_profiles
  FOR EACH ROW EXECUTE FUNCTION public.staff_profiles_derive_base_role();

-- permission tables move to role_id
DROP POLICY IF EXISTS "Staff can read their own role permissions" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Role permissions viewable by authenticated" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Role permissions insert by admin" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Role permissions update by admin" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Role permissions delete by admin" ON public.role_page_permissions;
DROP POLICY IF EXISTS "Staff can read action permissions" ON public.role_action_permissions;

ALTER TABLE public.role_page_permissions ADD COLUMN role_id uuid REFERENCES public.staff_roles_catalog(id) ON DELETE CASCADE;
UPDATE public.role_page_permissions r SET role_id = c.id FROM public.staff_roles_catalog c WHERE c.role_key = r.role::text;
ALTER TABLE public.role_page_permissions ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE public.role_page_permissions DROP COLUMN role;
ALTER TABLE public.role_page_permissions ADD CONSTRAINT role_page_permissions_role_id_slug_key UNIQUE (role_id, page_slug);

ALTER TABLE public.role_action_permissions ADD COLUMN role_id uuid REFERENCES public.staff_roles_catalog(id) ON DELETE CASCADE;
UPDATE public.role_action_permissions r SET role_id = c.id FROM public.staff_roles_catalog c WHERE c.role_key = r.role::text;
ALTER TABLE public.role_action_permissions ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE public.role_action_permissions DROP COLUMN role;
ALTER TABLE public.role_action_permissions ADD CONSTRAINT role_action_permissions_role_id_key_key UNIQUE (role_id, action_key);

REVOKE INSERT, UPDATE, DELETE ON public.role_page_permissions FROM authenticated, anon;
REVOKE ALL ON public.role_page_permissions FROM anon;
GRANT SELECT ON public.role_page_permissions TO authenticated;
GRANT ALL ON public.role_page_permissions TO service_role;

CREATE OR REPLACE FUNCTION public.staff_role_id_of(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT sp.role_id FROM public.staff_profiles sp WHERE sp.user_id = _user_id AND sp.is_active LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.staff_can_manage_roles(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_owner(_user_id) OR public.is_super_admin(_user_id)
    OR EXISTS (SELECT 1 FROM public.staff_profiles sp JOIN public.role_action_permissions rap ON rap.role_id = sp.role_id
               WHERE sp.user_id = _user_id AND sp.is_active AND rap.is_allowed
                 AND rap.action_key IN ('roles_permissions.manage_permissions','roles_permissions.assign_role','roles_permissions.create_role'))
$$;

CREATE POLICY "Read own role or manage roles" ON public.staff_roles_catalog FOR SELECT TO authenticated
  USING (id = public.staff_role_id_of(auth.uid()) OR public.staff_can_manage_roles(auth.uid()) OR public.has_role(auth.uid(),'admin'::public.app_role));
CREATE POLICY "Read own role page permissions or manage roles" ON public.role_page_permissions FOR SELECT TO authenticated
  USING (role_id = public.staff_role_id_of(auth.uid()) OR public.staff_can_manage_roles(auth.uid()) OR public.has_role(auth.uid(),'admin'::public.app_role));
CREATE POLICY "Read own role action permissions or manage roles" ON public.role_action_permissions FOR SELECT TO authenticated
  USING (role_id = public.staff_role_id_of(auth.uid()) OR public.staff_can_manage_roles(auth.uid()) OR public.has_role(auth.uid(),'admin'::public.app_role));

-- core checks
CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND _user_id IS NOT DISTINCT FROM auth.uid()
    AND CASE
      WHEN public.is_owner(_user_id) THEN true
      WHEN EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = _user_id)
        THEN EXISTS (SELECT 1 FROM public.staff_profiles sp JOIN public.staff_roles_catalog c ON c.id = sp.role_id
                     WHERE sp.user_id = _user_id AND sp.is_active AND c.is_owner_role)
      ELSE public.has_role(_user_id, 'admin'::public.app_role)
    END;
$$;

CREATE OR REPLACE FUNCTION public.staff_has_action(_user_id uuid, _action_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.is_owner(_user_id) OR public.is_super_admin(_user_id)
    OR EXISTS (SELECT 1 FROM public.staff_profiles sp
               JOIN public.staff_roles_catalog c ON c.id = sp.role_id AND c.is_active
               JOIN public.role_action_permissions rap ON rap.role_id = sp.role_id
               WHERE sp.user_id = _user_id AND sp.is_active AND rap.action_key = _action_key AND rap.is_allowed)
$$;

CREATE OR REPLACE FUNCTION public.staff_has_page_access(p_page_slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(p_page_slug,'') <> '' AND EXISTS (
    SELECT 1 FROM public.staff_profiles sp
    JOIN public.staff_roles_catalog c ON c.id = sp.role_id AND c.is_active
    JOIN public.role_page_permissions rpp ON rpp.role_id = sp.role_id AND rpp.page_slug = p_page_slug AND rpp.can_access
    WHERE sp.user_id = auth.uid() AND sp.is_active)
$$;

CREATE OR REPLACE FUNCTION public.staff_has_company_funds_read_access(p_page_slug text DEFAULT 'payout-ledger')
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_profiles sp
    JOIN public.staff_roles_catalog c ON c.id = sp.role_id AND c.is_active
    JOIN public.role_page_permissions rpp ON rpp.role_id = sp.role_id AND rpp.page_slug = p_page_slug AND rpp.can_access
    WHERE sp.user_id = auth.uid() AND sp.is_active
      AND c.base_role = ANY (ARRAY['super_admin','admin','finance_manager']::public.staff_role[]))
$$;

-- permission writes
DROP FUNCTION public.admin_set_role_page_permission(public.staff_role, text, boolean, text);
DROP FUNCTION public.admin_set_role_action_permission(public.staff_role, text, boolean, text);

CREATE FUNCTION public.admin_set_role_page_permission(_role_id uuid, _page_slug text, _can_access boolean, _correlation_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prev boolean; v_role public.staff_roles_catalog%ROWTYPE; v_details jsonb;
BEGIN
  SELECT * INTO v_role FROM public.staff_roles_catalog WHERE id = _role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  v_details := jsonb_build_object('target_role', v_role.name, 'role_id', _role_id, 'page_slug', _page_slug,
    'new_access', _can_access, 'correlation_id', _correlation_id, 'permission_keys_changed', jsonb_build_array('page:'||_page_slug));
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.manage_permissions') THEN
    PERFORM public.reject_roles_action('roles.permission.toggle','You do not have permission to perform this action.', v_details); END IF;
  IF v_role.is_owner_role THEN
    PERFORM public.reject_roles_action('roles.permission.protected_attempt','The Super Admin role is protected and cannot be changed.', v_details); END IF;
  IF _role_id = public.staff_role_id_of(auth.uid()) AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked','You cannot change the permissions of your own role.', v_details); END IF;
  IF _can_access AND NOT public.is_super_admin(auth.uid()) AND NOT public.staff_has_page_access(_page_slug) THEN
    PERFORM public.reject_roles_action('roles.permission.toggle','You cannot grant a permission you do not have.', v_details); END IF;
  SELECT can_access INTO v_prev FROM public.role_page_permissions WHERE role_id = _role_id AND page_slug = _page_slug;
  INSERT INTO public.role_page_permissions (role_id, page_slug, can_access) VALUES (_role_id, _page_slug, _can_access)
  ON CONFLICT (role_id, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access, updated_at = now();
  PERFORM public.log_roles_audit('roles.permission.toggle', v_details || jsonb_build_object('previous_access', v_prev, 'result','success'));
END $$;

CREATE FUNCTION public.admin_set_role_action_permission(_role_id uuid, _action_key text, _is_allowed boolean, _correlation_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prev boolean; v_role public.staff_roles_catalog%ROWTYPE; v_details jsonb;
BEGIN
  SELECT * INTO v_role FROM public.staff_roles_catalog WHERE id = _role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  v_details := jsonb_build_object('target_role', v_role.name, 'role_id', _role_id, 'action_key', _action_key, 'new_value', _is_allowed,
    'correlation_id', _correlation_id, 'permission_keys_changed', jsonb_build_array(_action_key));
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.manage_permissions') THEN
    PERFORM public.reject_roles_action('roles.action_permission.toggle','You do not have permission to perform this action.', v_details); END IF;
  IF v_role.is_owner_role THEN
    PERFORM public.reject_roles_action('roles.permission.protected_attempt','The Super Admin role is protected and cannot be changed.', v_details); END IF;
  IF _role_id = public.staff_role_id_of(auth.uid()) AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked','You cannot change the permissions of your own role.', v_details); END IF;
  IF _is_allowed AND NOT public.staff_has_action(auth.uid(), _action_key) THEN
    PERFORM public.reject_roles_action('roles.action_permission.toggle','You cannot grant a permission you do not have.', v_details); END IF;
  SELECT is_allowed INTO v_prev FROM public.role_action_permissions WHERE role_id = _role_id AND action_key = _action_key;
  INSERT INTO public.role_action_permissions (role_id, action_key, is_allowed) VALUES (_role_id, _action_key, _is_allowed)
  ON CONFLICT (role_id, action_key) DO UPDATE SET is_allowed = EXCLUDED.is_allowed, updated_at = now();
  PERFORM public.log_roles_audit('roles.action_permission.toggle', v_details || jsonb_build_object('previous_value', v_prev, 'result','success'));
END $$;

-- role catalog management
CREATE FUNCTION public.admin_save_staff_role(_role_id uuid, _name text, _description text, _base_role public.staff_role,
  _is_active boolean DEFAULT true, _copy_from_role_id uuid DEFAULT NULL, _correlation_id text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_old public.staff_roles_catalog%ROWTYPE; v_details jsonb; v_name text := btrim(coalesce(_name,''));
BEGIN
  v_details := jsonb_build_object('role_id', _role_id, 'name', v_name, 'base_role', _base_role, 'is_active', _is_active,
    'copy_from_role_id', _copy_from_role_id, 'correlation_id', _correlation_id);
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.manage_permissions') THEN
    PERFORM public.reject_roles_action('roles.role.save','You do not have permission to perform this action.', v_details); END IF;
  IF length(v_name) < 2 OR length(v_name) > 60 THEN RAISE EXCEPTION 'Role name must be 2–60 characters'; END IF;
  IF length(coalesce(_description,'')) > 300 THEN RAISE EXCEPTION 'Description must be 300 characters or fewer'; END IF;
  IF _base_role = 'super_admin' THEN
    PERFORM public.reject_roles_action('roles.role.save','Only the protected Super Admin role can use the Super Admin level.', v_details); END IF;

  IF _role_id IS NULL THEN
    INSERT INTO public.staff_roles_catalog (role_key, name, description, base_role, is_active, created_by)
    VALUES ('custom_' || replace(gen_random_uuid()::text,'-',''), v_name, NULLIF(btrim(_description),''), _base_role, _is_active, auth.uid())
    RETURNING id INTO v_id;
    IF _copy_from_role_id IS NOT NULL THEN
      INSERT INTO public.role_page_permissions (role_id, page_slug, can_access)
        SELECT v_id, page_slug, can_access FROM public.role_page_permissions
        WHERE role_id = _copy_from_role_id AND (NOT can_access OR public.is_super_admin(auth.uid()) OR public.staff_has_page_access(page_slug));
      INSERT INTO public.role_action_permissions (role_id, action_key, is_allowed)
        SELECT v_id, action_key, is_allowed FROM public.role_action_permissions
        WHERE role_id = _copy_from_role_id AND (NOT is_allowed OR public.staff_has_action(auth.uid(), action_key));
    END IF;
    PERFORM public.log_roles_audit('roles.role.create', v_details || jsonb_build_object('role_id', v_id, 'result','success'));
    RETURN v_id;
  END IF;

  SELECT * INTO v_old FROM public.staff_roles_catalog WHERE id = _role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  IF v_old.is_owner_role THEN
    PERFORM public.reject_roles_action('roles.permission.protected_attempt','The Super Admin role is protected and cannot be changed.', v_details); END IF;
  IF _role_id = public.staff_role_id_of(auth.uid()) AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked','You cannot change your own role.', v_details); END IF;
  UPDATE public.staff_roles_catalog SET name = v_name, description = NULLIF(btrim(_description),''),
    base_role = _base_role, is_active = _is_active WHERE id = _role_id;
  -- re-derive base level for staff on this role
  UPDATE public.staff_profiles SET role_id = role_id WHERE role_id = _role_id;
  PERFORM public.log_roles_audit('roles.role.update', v_details || jsonb_build_object(
    'previous_values', jsonb_build_object('name', v_old.name, 'base_role', v_old.base_role, 'is_active', v_old.is_active), 'result','success'));
  RETURN _role_id;
END $$;

CREATE FUNCTION public.admin_delete_staff_role(_role_id uuid, _correlation_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.staff_roles_catalog%ROWTYPE; v_details jsonb;
BEGIN
  SELECT * INTO v_old FROM public.staff_roles_catalog WHERE id = _role_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Role not found'; END IF;
  v_details := jsonb_build_object('role_id', _role_id, 'name', v_old.name, 'correlation_id', _correlation_id);
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.manage_permissions') THEN
    PERFORM public.reject_roles_action('roles.role.delete','You do not have permission to perform this action.', v_details); END IF;
  IF v_old.is_owner_role THEN
    PERFORM public.reject_roles_action('roles.permission.protected_attempt','The Super Admin role cannot be deleted.', v_details); END IF;
  IF EXISTS (SELECT 1 FROM public.staff_profiles WHERE role_id = _role_id) THEN
    PERFORM public.reject_roles_action('roles.role.delete','Move every staff member off this role before deleting it.', v_details); END IF;
  DELETE FROM public.staff_roles_catalog WHERE id = _role_id;
  PERFORM public.log_roles_audit('roles.role.delete', v_details || jsonb_build_object('result','success'));
END $$;

-- staff create / reassign by role_id
DROP FUNCTION public.admin_create_staff_member(uuid, text, text, public.staff_role, uuid[], text);
DROP FUNCTION public.admin_assign_staff_role(uuid, public.staff_role, text);

CREATE FUNCTION public.admin_create_staff_member(_user_id uuid, _full_name text, _username text, _role_id uuid,
  _service_area_ids uuid[] DEFAULT '{}', _correlation_id text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_role public.staff_roles_catalog%ROWTYPE; v_details jsonb;
BEGIN
  SELECT * INTO v_role FROM public.staff_roles_catalog WHERE id = _role_id;
  IF NOT FOUND OR NOT v_role.is_active THEN RAISE EXCEPTION 'Role not found or inactive'; END IF;
  v_details := jsonb_build_object('target_user_id', _user_id, 'full_name', _full_name, 'role', v_role.name, 'role_id', _role_id,
    'service_areas_added', to_jsonb(_service_area_ids), 'correlation_id', _correlation_id);
  IF NOT public.staff_has_action(auth.uid(), 'roles_permissions.create_role') THEN
    PERFORM public.reject_roles_action('roles.staff.add','You do not have permission to perform this action.', v_details); END IF;
  IF v_role.is_owner_role AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.super_admin_promote_attempt','Only an existing Super Admin can grant the Super Admin role.', v_details); END IF;
  IF array_length(_service_area_ids,1) > 0 AND NOT public.staff_has_action(auth.uid(),'roles_permissions.assign_service_areas') THEN
    PERFORM public.reject_roles_action('roles.staff.add','You do not have permission to assign service areas.', v_details); END IF;
  INSERT INTO public.staff_profiles (user_id, full_name, username, role_id, role, staff_role_id, created_by)
  VALUES (_user_id, _full_name, NULLIF(_username,''), _role_id, v_role.base_role, 'TEMP', auth.uid()) RETURNING id INTO v_id;
  IF array_length(_service_area_ids,1) > 0 THEN
    INSERT INTO public.staff_service_areas (staff_id, service_area_id) SELECT v_id, unnest(_service_area_ids); END IF;
  PERFORM public.log_roles_audit('roles.staff.add', v_details || jsonb_build_object('target_staff_id', v_id, 'result','success'));
  RETURN v_id;
END $$;

CREATE FUNCTION public.admin_assign_staff_role(_staff_id uuid, _new_role_id uuid, _correlation_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.staff_profiles%ROWTYPE; v_old public.staff_roles_catalog%ROWTYPE; v_new public.staff_roles_catalog%ROWTYPE; v_details jsonb;
BEGIN
  SELECT * INTO v_row FROM public.staff_profiles WHERE id = _staff_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff member not found'; END IF;
  SELECT * INTO v_old FROM public.staff_roles_catalog WHERE id = v_row.role_id;
  SELECT * INTO v_new FROM public.staff_roles_catalog WHERE id = _new_role_id;
  IF NOT FOUND OR NOT v_new.is_active THEN RAISE EXCEPTION 'Role not found or inactive'; END IF;
  v_details := jsonb_build_object('target_staff_id', _staff_id, 'target_user_id', v_row.user_id, 'is_owner', v_row.is_owner,
    'previous_role', v_old.name, 'new_role', v_new.name,
    'previous_values', jsonb_build_object('role_id', v_old.id), 'new_values', jsonb_build_object('role_id', v_new.id),
    'correlation_id', _correlation_id);
  IF v_row.is_owner AND NOT v_new.is_owner_role THEN
    PERFORM public.reject_roles_action('roles.owner.protected_attempt','The ONECAB Owner cannot be downgraded from Super Admin.', v_details); END IF;
  IF v_row.user_id = auth.uid() AND _new_role_id <> v_row.role_id THEN
    PERFORM public.reject_roles_action('roles.staff.self_action_blocked','You cannot change your own role.', v_details); END IF;
  IF NOT public.staff_has_action(auth.uid(),'roles_permissions.assign_role') THEN
    PERFORM public.reject_roles_action('roles.staff.reassign','You do not have permission to perform this action.', v_details); END IF;
  IF (v_new.is_owner_role OR v_old.is_owner_role) AND NOT public.is_super_admin(auth.uid()) THEN
    PERFORM public.reject_roles_action('roles.staff.super_admin_promote_attempt','Only an existing Super Admin can grant or change the Super Admin role.', v_details); END IF;
  IF v_old.is_owner_role AND NOT v_new.is_owner_role AND v_row.is_active AND public.active_super_admin_count() <= 1 THEN
    PERFORM public.reject_roles_action('roles.staff.protected_attempt','The last active Super Admin cannot be downgraded.', v_details); END IF;
  UPDATE public.staff_profiles SET role_id = _new_role_id, updated_at = now() WHERE id = _staff_id;
  PERFORM public.log_roles_audit(CASE WHEN v_new.is_owner_role THEN 'roles.staff.promote_super_admin' ELSE 'roles.staff.reassign' END,
    v_details || jsonb_build_object('result','success'));
END $$;

REVOKE ALL ON FUNCTION public.admin_set_role_page_permission(uuid,text,boolean,text), public.admin_set_role_action_permission(uuid,text,boolean,text),
  public.admin_save_staff_role(uuid,text,text,public.staff_role,boolean,uuid,text), public.admin_delete_staff_role(uuid,text),
  public.admin_create_staff_member(uuid,text,text,uuid,uuid[],text), public.admin_assign_staff_role(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_role_page_permission(uuid,text,boolean,text), public.admin_set_role_action_permission(uuid,text,boolean,text),
  public.admin_save_staff_role(uuid,text,text,public.staff_role,boolean,uuid,text), public.admin_delete_staff_role(uuid,text),
  public.admin_create_staff_member(uuid,text,text,uuid,uuid[],text), public.admin_assign_staff_role(uuid,uuid,text) TO authenticated;
REVOKE ALL ON FUNCTION public.staff_profiles_derive_base_role() FROM PUBLIC, anon, authenticated;
