INSERT INTO public.role_page_permissions (role, page_slug, can_access)
SELECT r.role::public.staff_role, 'customer-special-offers', r.can_access
FROM (VALUES
  ('super_admin', true),
  ('admin', true),
  ('operator', false),
  ('finance_manager', false),
  ('customer_support', false),
  ('compliance_officer', false)
) AS r(role, can_access)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;