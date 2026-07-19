-- P0: Expand company payee types + archive/verified metadata.
-- Company Transfers remain isolated from Driver Wallet / Payment Sessions.

BEGIN;

ALTER TABLE public.company_payees
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- Drop legacy payee_type check (name may vary); re-add expanded set.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'company_payees'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%payee_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.company_payees DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.company_payees
  ADD CONSTRAINT company_payees_payee_type_check
  CHECK (payee_type IN (
    'STAFF',
    'DIRECTOR',
    'CONTRACTOR',
    'SUPPLIER',
    'OFFICE_EXPENSE',
    'SOFTWARE_SUBSCRIPTION',
    'HMRC_TAX',
    'INSURANCE',
    'VEHICLE_SUPPLIER',
    'REFUND_RECIPIENT',
    'EXPENSE_CLAIMANT',
    'OTHER'
  ));

CREATE INDEX IF NOT EXISTS idx_company_payees_archived
  ON public.company_payees (archived_at)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN public.company_payees.archived_at IS
  'Soft-archive timestamp; archived payees cannot receive new company transfers.';
COMMENT ON COLUMN public.company_payees.verified_at IS
  'When account_verification_status became VERIFIED (provider or admin).';

COMMIT;
