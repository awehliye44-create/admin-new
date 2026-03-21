INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'qr-booking', true),
  ('admin', 'qr-booking', true),
  ('operator', 'qr-booking', true),
  ('finance_manager', 'qr-booking', false),
  ('customer_support', 'qr-booking', false),
  ('compliance_officer', 'qr-booking', false)
ON CONFLICT DO NOTHING;