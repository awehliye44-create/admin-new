-- Payment Providers page uses integrations access; seed explicit slug for sidebar route
INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'payment-providers', true),
  ('admin', 'payment-providers', true),
  ('finance_manager', 'payment-providers', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;
