CREATE OR REPLACE FUNCTION public.block_non_delegable_permissions()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner boolean; v_row jsonb := to_jsonb(NEW);
BEGIN
  SELECT is_owner_role INTO v_owner FROM public.staff_roles_catalog WHERE id = NEW.role_id;
  IF coalesce(v_owner,false) THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'role_page_permissions' THEN
    IF v_row->>'page_slug' = 'roles' AND coalesce((v_row->>'can_access')::boolean,false) THEN
      RAISE EXCEPTION 'Roles & Permissions is reserved for the ONECAB Owner.' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'role_action_permissions' THEN
    IF v_row->>'action_key' LIKE 'roles_permissions.%' AND coalesce((v_row->>'is_allowed')::boolean,false) THEN
      RAISE EXCEPTION 'Staff management permissions are reserved for the ONECAB Owner.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.block_non_delegable_permissions() FROM PUBLIC, anon, authenticated;