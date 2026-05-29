INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES ('super_admin','merchants',true),('admin','merchants',true),('operator','merchants',true)
ON CONFLICT DO NOTHING;