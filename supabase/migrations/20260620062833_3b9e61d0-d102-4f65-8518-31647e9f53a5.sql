
-- Revoke any client access to sensitive tables; only service_role (edge functions) may access raw rows.
REVOKE ALL ON public.call_masking_sessions FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.call_masking_call_logs FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.payment_provider_vault FROM anon, authenticated, PUBLIC;

-- Ensure RLS remains enabled with default-deny on the vault (no policies = no access).
ALTER TABLE public.payment_provider_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_provider_vault FORCE ROW LEVEL SECURITY;
ALTER TABLE public.call_masking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.call_masking_call_logs ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.call_masking_sessions TO service_role;
GRANT ALL ON public.call_masking_call_logs TO service_role;
GRANT ALL ON public.payment_provider_vault TO service_role;
