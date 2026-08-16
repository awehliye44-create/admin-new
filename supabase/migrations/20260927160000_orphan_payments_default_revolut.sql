-- Orphan payments default provider: Revolut-only live path.
ALTER TABLE public.orphan_payments ALTER COLUMN payment_provider SET DEFAULT 'revolut';
COMMENT ON COLUMN public.orphan_payments.payment_provider IS 'Live provider for orphan rows; Revolut-only.';
