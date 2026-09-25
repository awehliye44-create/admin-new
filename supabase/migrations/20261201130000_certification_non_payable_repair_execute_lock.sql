-- Privilege-hardening follow-up for admin_apply_certification_non_payable_repair.
--
-- Context: 20261201120000 created the SECURITY DEFINER RPC and only
--   REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO service_role.
-- Schema default privileges still left explicit EXECUTE on anon + authenticated.
-- Production was privilege-corrected manually; this migration records and
-- reproduces that hardened ACL in migration history without touching the
-- already-applied 20261201120000 source.
--
-- Idempotent: safe when privileges are already service_role-only.
-- Does NOT alter global/schema default privileges.
-- Does NOT change function body, signature, or any table data.

BEGIN;

REVOKE ALL ON FUNCTION public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb, text
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb, text
) FROM anon;

REVOKE ALL ON FUNCTION public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb, text
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb, text
) TO service_role;

COMMIT;
