-- ============================================================
-- Phase A8B8: close anon EXECUTE on admin_user_directory + ACL-lock
-- nine high-impact authenticated orphans / edge-postgres helpers.
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, RLS, cron,
-- trigger, or search_path change.
--
-- PART A — AUTHENTICATED_REQUIRED (revoke PUBLIC + anon only):
--   admin_user_directory()
--     Admin UI: src/pages/UserDirectory.tsx via publishable client + staff JWT
--     Route: /user-directory (ProtectedRoute + AdminPageAccessGate slug)
--     Body gate: is_super_admin | staff_has_page_access('user-directory') | has_role(admin)
--     Anon privilege source: EXPLICIT grant anon=X/postgres (not PUBLIC inheritance)
--
-- PART B (9):
--   ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--     adjust_merchant_credits(uuid, integer, text)
--     approve_merchant_with_credits(uuid, text)
--     get_driver_wallet_balance(uuid)
--   EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; retain service_role):
--     ops_retry_failed_payout(uuid)              ← ops-ai-fix service_role
--     check_driver_documents_approved(uuid)      ← guard-onboarding-login service
--                                                   + SQL parents/triggers
--   POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role):
--     reject_roles_action(text, text, jsonb)     ← admin_* staff SECDEF parents
--     log_roles_audit(text, jsonb)               ← admin_* / reject_roles_action
--     accept_ride_offer_eligibility_guard(uuid)  ← tr_block_ineligible_ride_offer
--     dispatchable_reason(uuid, integer, boolean, integer)
--                                                ← is_driver_dispatchable / snapshot
--
-- Explicitly excluded:
--   ops_retry_failed_payout_item / return_failed_payout_to_wallet (Admin JWT)
--   driver_wallet_eligibility_balances / admin_driver_wallet_eligibility_balances
--   has_role / is_super_admin / is_owner / has_corporate_access / can_write_corporate
--   submit_driver_location_sample
--   A8B5B2 notification / Vault / SDN path
--   ride_offer_enqueue_reminders (notification HTTP side effects)
--   financial-model helpers that would alter model rules
--   six RLS-no-policy INFO findings
--
-- Expected Advisor changes:
--   anon_security_definer_function_executable: 1 → 0 (category may clear)
--   authenticated_security_definer_function_executable: 177 → 168 (−9)
--   Security Advisor categories: 3 → 2
--   rls_enabled_no_policy INFO: remains 6
--   mutable search_path: remains 0
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   admin_user_directory: ba37343c189c21d6c4d902d60cad8282
--   adjust_merchant_credits: 32cfb21497afe0fa7c6f22b7c181ce96
--   approve_merchant_with_credits: 906a8505878a8871e6a7711c47e0980b
--   get_driver_wallet_balance: 12f11da8c01d0b64b3c517ebe965e363
--   ops_retry_failed_payout: 817dfb0ebb4321af2ecba73fc11b8be4
--   check_driver_documents_approved: b028018a57c8acfca1b6e1f59e7fc2c5
--   reject_roles_action: 4e95174d7597995f8da85b2640191351
--   log_roles_audit: 5bb207836420031322a83af08692bf54
--   accept_ride_offer_eligibility_guard: ac499859d589358f39ad28312a951c65
--   dispatchable_reason: 5ab192f82e01e6fe9dcd3f583a7a2dc7

-- PART A
REVOKE ALL ON FUNCTION public.admin_user_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_directory() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO service_role;

-- PART B — ORPHANED
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM service_role;

REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM service_role;

-- PART B — EDGE_SERVICE_ONLY
REVOKE ALL ON FUNCTION public.ops_retry_failed_payout(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_retry_failed_payout(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_retry_failed_payout(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_payout(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_driver_documents_approved(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_driver_documents_approved(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_driver_documents_approved(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;

-- PART B — POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM service_role;

COMMIT;
