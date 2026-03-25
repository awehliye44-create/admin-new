INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'document-management', true),
  ('admin', 'document-management', true),
  ('operator', 'document-management', true),
  ('compliance_officer', 'document-management', true),
  ('finance_manager', 'document-management', false),
  ('customer_support', 'document-management', false)
ON CONFLICT (role, page_slug) DO NOTHING;