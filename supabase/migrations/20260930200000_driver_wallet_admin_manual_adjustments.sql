-- Driver Wallet manual admin adjustments — append-only ledger + audit/approval queue.
-- Parked schema only: DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED stays false until enablement.
BEGIN;

-- Optional metadata for driver-visible reason fields (no admin PII in description).
ALTER TABLE public.driver_wallet_ledger
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT IF EXISTS driver_wallet_ledger_type_check;
ALTER TABLE public.driver_wallet_ledger ADD CONSTRAINT driver_wallet_ledger_type_check
  CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET'::text,
    'CASH_TRIP_EARNING'::text,
    'CASH_COMMISSION_DEBT'::text,
    'DRIVER_TIP_CREDIT'::text,
    'TIP_CREDIT'::text,
    'PLATFORM_COMMISSION'::text,
    'COMPANY_COMMISSION'::text,
    'WEEKLY_PAYOUT'::text,
    'EARLY_CASHOUT'::text,
    'CASHOUT_FEE'::text,
    'ADJUSTMENT'::text,
    'REFUND_DEBIT'::text,
    'PAYOUT'::text,
    'MANUAL_PAYOUT'::text,
    'BONUS'::text,
    'DEBT_RECOVERY'::text,
    'COMMISSION_RECOVERED'::text,
    'LEDGER_REVERSAL'::text,
    'PAYOUT_FAILED_RETURN'::text,
    'PAYOUT_RESERVATION_HOLD'::text,
    'PAYOUT_RESERVATION_RELEASE'::text,
    'ADMIN_WALLET_CREDIT'::text,
    'ADMIN_WALLET_DEBIT'::text
  ]));

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_manual_adj_idempotency_uidx
  ON public.driver_wallet_ledger (provider_transfer_id)
  WHERE provider_transfer_id LIKE 'dw_manual_adj:%';

CREATE TABLE IF NOT EXISTS public.driver_wallet_admin_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid REFERENCES public.service_areas(id),
  status text NOT NULL DEFAULT 'PENDING_APPROVAL'
    CHECK (status = ANY (ARRAY['PENDING_APPROVAL'::text, 'APPLIED'::text, 'REJECTED'::text])),
  direction text NOT NULL CHECK (direction = ANY (ARRAY['CREDIT'::text, 'DEBIT'::text])),
  amount_pence integer NOT NULL CHECK (amount_pence >= 1),
  signed_amount_pence integer,
  currency text NOT NULL DEFAULT 'GBP' CHECK (upper(currency) = 'GBP'),
  reason_category text NOT NULL,
  reason_note text NOT NULL,
  evidence_reference text,
  ledger_type text NOT NULL
    CHECK (ledger_type = ANY (ARRAY['ADMIN_WALLET_CREDIT'::text, 'ADMIN_WALLET_DEBIT'::text])),
  payout_eligible boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL,
  related_trip_id uuid REFERENCES public.trips(id),
  related_payout_item_id uuid REFERENCES public.payout_items(id),
  created_by_admin_id uuid NOT NULL,
  approved_by_admin_id uuid,
  rejected_by_admin_id uuid,
  ledger_entry_id uuid REFERENCES public.driver_wallet_ledger(id),
  requires_owner_approval boolean NOT NULL DEFAULT false,
  approval_reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  rejected_at timestamptz,
  rejection_note text
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_admin_adjustments_idempotency_uidx
  ON public.driver_wallet_admin_adjustments (idempotency_key);

CREATE INDEX IF NOT EXISTS driver_wallet_admin_adjustments_driver_idx
  ON public.driver_wallet_admin_adjustments (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS driver_wallet_admin_adjustments_status_idx
  ON public.driver_wallet_admin_adjustments (status, created_at DESC);

ALTER TABLE public.driver_wallet_admin_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS driver_wallet_admin_adjustments_admin_read
  ON public.driver_wallet_admin_adjustments;
CREATE POLICY driver_wallet_admin_adjustments_admin_read
  ON public.driver_wallet_admin_adjustments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active = true
        AND sp.role = ANY (ARRAY['super_admin', 'admin', 'finance_manager']::public.staff_role[])
    )
  );

DROP POLICY IF EXISTS driver_wallet_admin_adjustments_driver_read
  ON public.driver_wallet_admin_adjustments;
CREATE POLICY driver_wallet_admin_adjustments_driver_read
  ON public.driver_wallet_admin_adjustments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.user_id = auth.uid()
        AND d.id = driver_wallet_admin_adjustments.driver_id
        AND driver_wallet_admin_adjustments.status = 'APPLIED'
    )
  );

-- No authenticated INSERT/UPDATE/DELETE policies on driver_wallet_admin_adjustments.
-- Mutations are service_role / edge only (admin-driver-adjustment).

-- Close authenticated client writes on driver_wallet_ledger (legacy admin ALL policy).
DROP POLICY IF EXISTS "Admins can manage driver wallet ledger"
  ON public.driver_wallet_ledger;

-- Finance staff may read ledger rows (admin UI); writes remain service_role / edge only.
DROP POLICY IF EXISTS driver_wallet_ledger_finance_read
  ON public.driver_wallet_ledger;
CREATE POLICY driver_wallet_ledger_finance_read
  ON public.driver_wallet_ledger
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active = true
        AND sp.role = ANY (ARRAY['super_admin', 'admin', 'finance_manager']::public.staff_role[])
    )
  );

-- Drivers read own admin adjustment ledger rows (in addition to existing own-ledger SELECT policies).
DROP POLICY IF EXISTS driver_wallet_ledger_driver_read_admin_adjustments
  ON public.driver_wallet_ledger;
CREATE POLICY driver_wallet_ledger_driver_read_admin_adjustments
  ON public.driver_wallet_ledger
  FOR SELECT
  TO authenticated
  USING (
    type = ANY (ARRAY['ADMIN_WALLET_CREDIT'::text, 'ADMIN_WALLET_DEBIT'::text])
    AND EXISTS (
      SELECT 1 FROM public.drivers d
      WHERE d.user_id = auth.uid()
        AND d.id = driver_wallet_ledger.driver_id
    )
  );

-- Ensure service_role write path remains explicit (edge uses service role client).
DROP POLICY IF EXISTS "Service role can manage wallet ledger"
  ON public.driver_wallet_ledger;
CREATE POLICY "Service role can manage wallet ledger"
  ON public.driver_wallet_ledger
  FOR ALL
  TO public
  USING (auth.role() = 'service_role'::text)
  WITH CHECK (auth.role() = 'service_role'::text);

COMMENT ON TABLE public.driver_wallet_admin_adjustments IS
  'Parked admin Driver Wallet adjustment queue. Ledger posts only via service_role edge; DRIVER_WALLET_ADMIN_ADJUSTMENTS_DEPLOYED stays false until enablement.';

COMMIT;
