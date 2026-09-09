-- Phase A7B: restrict direct is_owner oracle execution.
-- NOT APPLIED until explicitly approved.
--
-- Authenticated EXECUTE removed. service_role kept for the proven Edge caller.
-- Nested postgres-owned SECURITY DEFINER parents keep owner privilege.
-- Body, signature, and data are unchanged.

BEGIN;

REVOKE ALL ON FUNCTION public.is_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_owner(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_owner(uuid) FROM authenticated;

COMMIT;
