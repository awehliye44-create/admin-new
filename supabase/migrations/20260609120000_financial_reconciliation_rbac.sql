-- Register Financial Reconciliation page slug in RBAC for finance roles
INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'financial-reconciliation', true),
  ('admin', 'financial-reconciliation', true),
  ('finance_manager', 'financial-reconciliation', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;
