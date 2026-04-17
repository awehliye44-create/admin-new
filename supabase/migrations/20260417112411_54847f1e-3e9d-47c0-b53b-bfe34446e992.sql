
INSERT INTO public.role_page_permissions (role, page_slug, can_access) VALUES
  ('super_admin','offers',true),
  ('admin','offers',true),
  ('operator','offers',false),
  ('finance_manager','offers',false),
  ('customer_support','offers',false),
  ('compliance_officer','offers',false)
ON CONFLICT DO NOTHING;
