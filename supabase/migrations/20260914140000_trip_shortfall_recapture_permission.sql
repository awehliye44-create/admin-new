-- PROPOSED — do not apply without explicit approval.
-- Trip History shortfall recapture permission (Roles & Permissions SSOT).
-- Page slug: payments-trip-shortfall-recapture
-- Super Admin default grant; other roles opt-in via Roles & Permissions UI.

INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'payments-trip-shortfall-recapture', true),
  ('admin', 'payments-trip-shortfall-recapture', false),
  ('operator', 'payments-trip-shortfall-recapture', false),
  ('finance_manager', 'payments-trip-shortfall-recapture', false),
  ('customer_support', 'payments-trip-shortfall-recapture', false),
  ('compliance_officer', 'payments-trip-shortfall-recapture', false)
ON CONFLICT (role, page_slug) DO UPDATE
SET can_access = EXCLUDED.can_access;
