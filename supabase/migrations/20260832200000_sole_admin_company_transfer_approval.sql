-- Sole-admin company transfer approval (narrow four-eyes exception).
-- Default OFF. Certification limit 1p + CERTIFICATION type only until expanded.

INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES
  (
    'allow_sole_admin_company_transfer_approval',
    'false'::jsonb,
    'When true, a lone super_admin may self-approve within sole_admin_company_transfer_limit_pence if no second eligible approver exists. Does not disable four-eyes globally.'
  ),
  (
    'sole_admin_company_transfer_limit_pence',
    '1'::jsonb,
    'Max amount (pence) for sole-admin self-approval. Certification default = 1.'
  ),
  (
    'sole_admin_company_transfer_allowed_types',
    '"CERTIFICATION"'::jsonb,
    'Comma-separated transfer_type values permitted under sole-admin approval. Fail-closed default CERTIFICATION.'
  )
ON CONFLICT (setting_key) DO NOTHING;
