INSERT INTO role_page_permissions (role, page_slug)
VALUES
  ('super_admin', 'lost-property'),
  ('admin', 'lost-property'),
  ('operator', 'lost-property'),
  ('customer_support', 'lost-property'),
  ('finance_manager', 'lost-property'),
  ('compliance_officer', 'lost-property')
ON CONFLICT DO NOTHING;