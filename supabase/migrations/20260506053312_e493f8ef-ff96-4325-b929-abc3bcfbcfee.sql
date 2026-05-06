INSERT INTO role_page_permissions (role, page_slug, can_access) VALUES
('super_admin','dispatch-metrics',true),
('admin','dispatch-metrics',true),
('operator','dispatch-metrics',true),
('finance_manager','dispatch-metrics',false),
('customer_support','dispatch-metrics',false),
('compliance_officer','dispatch-metrics',false)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;