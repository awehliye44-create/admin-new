
ALTER TYPE merchant_status ADD VALUE IF NOT EXISTS 'disabled';

ALTER TABLE public.merchants
  ADD COLUMN IF NOT EXISTS admin_notes text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

INSERT INTO public.role_page_permissions (role, page_slug, can_access)
SELECT r::staff_role, s, true
FROM (VALUES ('super_admin'),('admin'),('operator')) AS roles(r)
CROSS JOIN (VALUES ('merchant-approvals'),('marketplace-settings')) AS slugs(s)
ON CONFLICT DO NOTHING;
