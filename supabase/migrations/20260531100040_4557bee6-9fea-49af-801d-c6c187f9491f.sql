INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'marketplace-settlements', true),
  ('admin', 'marketplace-settlements', true),
  ('operator', 'marketplace-settlements', true),
  ('finance_manager', 'marketplace-settlements', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;