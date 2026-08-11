ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_payment_classification TEXT,
  ADD COLUMN IF NOT EXISTS invoice_paid_pence INTEGER,
  ADD COLUMN IF NOT EXISTS invoice_outstanding_pence INTEGER,
  ADD COLUMN IF NOT EXISTS invoice_delivery_eligible BOOLEAN,
  ADD COLUMN IF NOT EXISTS invoice_payment_evidence_source TEXT,
  ADD COLUMN IF NOT EXISTS invoice_payment_evidence_ids TEXT[],
  ADD COLUMN IF NOT EXISTS invoice_payment_resolved_at TIMESTAMPTZ;