-- Phase 3C.6 — MK0002 po_1TjUCp Option 3 remediation (finance-approved split).
-- Debit wallet-backed £42.01 only; record £14.40 capture-failed leakage as operational loss.
-- Full Stripe payout £56.41 — driver wallet must NOT be debited for leakage portion.

-- =============================================================================
-- 1) Reconciliation notes — platform operational loss (does not affect driver wallet)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.finance_reconciliation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  stripe_payout_id text NOT NULL,
  stripe_payout_amount_pence integer NOT NULL,
  ledger_debit_pence integer NOT NULL,
  operational_loss_pence integer NOT NULL DEFAULT 0,
  remediation_option text NOT NULL,
  classification text,
  note text NOT NULL,
  reference_doc text,
  ledger_entry_id uuid REFERENCES public.driver_wallet_ledger(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_reconciliation_notes_stripe_payout_unique UNIQUE (stripe_payout_id)
);

CREATE INDEX IF NOT EXISTS idx_finance_reconciliation_notes_driver
  ON public.finance_reconciliation_notes(driver_id, created_at DESC);

COMMENT ON TABLE public.finance_reconciliation_notes IS
  'Documents split remediation when Stripe payout ≠ wallet-backed ledger debit (e.g. capture-failed leakage write-off).';

ALTER TABLE public.finance_reconciliation_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_reconciliation_notes_service_role
  ON public.finance_reconciliation_notes
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY finance_reconciliation_notes_admin_read
  ON public.finance_reconciliation_notes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );

-- =============================================================================
-- 2) MK0002 — partial ledger debit (£42.01 wallet-backed)
-- =============================================================================
DO $$
DECLARE
  v_ledger_id uuid;
  v_driver_id uuid := 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';
  v_stripe_payout text := 'po_1TjUCpIzd0dzmC0Y65sJxUHu';
  v_stripe_amount integer := 5641;
  v_ledger_debit integer := -4201;
  v_operational_loss integer := 1440;
BEGIN
  IF EXISTS (
    SELECT 1 FROM driver_wallet_ledger
    WHERE stripe_payout_id = v_stripe_payout
      AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
  ) THEN
    RAISE NOTICE 'MK0002 po_1TjUCp ledger debit already exists — skipping insert';
    SELECT id INTO v_ledger_id
    FROM driver_wallet_ledger
    WHERE stripe_payout_id = v_stripe_payout
    LIMIT 1;
  ELSE
    v_ledger_id := insert_payout_ledger_debit_if_missing(
      p_driver_id := v_driver_id,
      p_amount_pence := v_ledger_debit,
      p_ledger_type := 'WEEKLY_PAYOUT',
      p_currency := 'GBP',
      p_description := 'Phase 3C.6 Option 3 — wallet-backed £42.01 of Stripe po_1TjUCp (£56.41). £14.40 capture-failed leakage → operational loss (finance_reconciliation_notes).',
      p_stripe_transfer_id := NULL,
      p_stripe_payout_id := v_stripe_payout,
      p_paid_at := '2026-06-18T00:53:19Z'::timestamptz
    );
  END IF;

  INSERT INTO public.finance_reconciliation_notes (
    driver_id,
    stripe_payout_id,
    stripe_payout_amount_pence,
    ledger_debit_pence,
    operational_loss_pence,
    remediation_option,
    classification,
    note,
    reference_doc,
    ledger_entry_id,
    metadata
  ) VALUES (
    v_driver_id,
    v_stripe_payout,
    v_stripe_amount,
    v_ledger_debit,
    v_operational_loss,
    'OPTION_3_SPLIT',
    'CAPTURE_FAILED_LEAKAGE_WRITE_OFF',
    'Stripe Connect auto-payout £56.41 paid to MK0002 bank. Ledger debited £42.01 (nine wallet-backed trips in payout set). £14.40 excluded from driver debit — three capture_failed trips (MK-260613-027/028/029) transferred before LEDGER_REVERSAL; platform operational loss per Phase 3C.7.',
    'docs/PHASE_3C7_MK0002_REVERSAL_LEAKAGE_AUDIT.md',
    v_ledger_id,
    jsonb_build_object(
      'leakage_trip_codes', jsonb_build_array('MK-260613-027', 'MK-260613-028', 'MK-260613-029'),
      'leakage_pence', v_operational_loss,
      'wallet_backed_pence', abs(v_ledger_debit),
      'projected_wallet_pence', 1901 + v_ledger_debit
    )
  )
  ON CONFLICT (stripe_payout_id) DO UPDATE SET
    ledger_debit_pence = EXCLUDED.ledger_debit_pence,
    operational_loss_pence = EXCLUDED.operational_loss_pence,
    ledger_entry_id = EXCLUDED.ledger_entry_id,
    note = EXCLUDED.note,
    metadata = EXCLUDED.metadata;
END $$;

SELECT recalculate_driver_wallet('cd8bae4c-3827-4b90-98c6-10be70eb0e52');
