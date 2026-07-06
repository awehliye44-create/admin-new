ALTER TABLE public.admin_payment_audit
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_payment_id text;

CREATE INDEX IF NOT EXISTS admin_payment_audit_provider_idx
  ON public.admin_payment_audit (provider, provider_payment_id)
  WHERE provider IS NOT NULL;