INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'alert-sounds', true),
  ('admin', 'alert-sounds', true),
  ('operator', 'alert-sounds', true),
  ('finance_manager', 'alert-sounds', false),
  ('customer_support', 'alert-sounds', false),
  ('compliance_officer', 'alert-sounds', false)
ON CONFLICT DO NOTHING;