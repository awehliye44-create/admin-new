
INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES ('super_admin', 'ops-intelligence', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = true;

INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES ('admin', 'ops-intelligence', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = true;
