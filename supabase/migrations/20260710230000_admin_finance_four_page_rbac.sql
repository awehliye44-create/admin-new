-- Mirror of onecab-comfy-ride admin finance four-page RBAC
INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'payment-sessions', true),
  ('admin', 'payment-sessions', true),
  ('finance_manager', 'payment-sessions', true),
  ('super_admin', 'driver-wallet-ledger', true),
  ('admin', 'driver-wallet-ledger', true),
  ('finance_manager', 'driver-wallet-ledger', true),
  ('super_admin', 'payout-ledger', true),
  ('admin', 'payout-ledger', true),
  ('finance_manager', 'payout-ledger', true)
ON CONFLICT (role, page_slug) DO UPDATE
SET can_access = EXCLUDED.can_access;
