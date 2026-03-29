-- Register invoice page slugs in RBAC for appropriate roles
INSERT INTO role_page_permissions (role, page_slug)
VALUES
  ('super_admin', 'invoices'),
  ('super_admin', 'invoice-templates'),
  ('super_admin', 'statement-runs'),
  ('admin', 'invoices'),
  ('admin', 'invoice-templates'),
  ('admin', 'statement-runs'),
  ('finance_manager', 'invoices'),
  ('finance_manager', 'invoice-templates'),
  ('finance_manager', 'statement-runs'),
  ('operator', 'invoices'),
  ('compliance_officer', 'invoices')
ON CONFLICT DO NOTHING;