-- Create payout_batches table for tracking payout runs
CREATE TABLE IF NOT EXISTS public.payout_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('WEEKLY_MONDAY', 'EARLY_CASHOUT', 'MANUAL_ADMIN')),
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'partial')),
  total_drivers INTEGER DEFAULT 0,
  total_amount_pence INTEGER DEFAULT 0,
  successful_payouts INTEGER DEFAULT 0,
  failed_payouts INTEGER DEFAULT 0,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Create payout_items table for individual payouts within a batch
CREATE TABLE IF NOT EXISTS public.payout_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID REFERENCES public.payout_batches(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  amount_pence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  stripe_transfer_id TEXT,
  stripe_payout_id TEXT,
  error_message TEXT,
  ledger_entry_id UUID REFERENCES public.driver_ledger(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add additional fields to trips table if they don't exist
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'extras_pence') THEN
    ALTER TABLE public.trips ADD COLUMN extras_pence INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'tip_pence') THEN
    ALTER TABLE public.trips ADD COLUMN tip_pence INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'authorised_amount_pence') THEN
    ALTER TABLE public.trips ADD COLUMN authorised_amount_pence INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'stripe_charge_id') THEN
    ALTER TABLE public.trips ADD COLUMN stripe_charge_id TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'stripe_processing_fee_pence') THEN
    ALTER TABLE public.trips ADD COLUMN stripe_processing_fee_pence INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'refund_amount_pence') THEN
    ALTER TABLE public.trips ADD COLUMN refund_amount_pence INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'refund_reason') THEN
    ALTER TABLE public.trips ADD COLUMN refund_reason TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'trips' AND column_name = 'refunded_at') THEN
    ALTER TABLE public.trips ADD COLUMN refunded_at TIMESTAMPTZ;
  END IF;
END $$;

-- Insert default commission settings into admin_settings if not exists
INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES 
  ('commission_percent', '20', 'Default commission percentage for platform'),
  ('commission_fixed_pence', '0', 'Fixed commission amount in pence added to percentage'),
  ('early_cashout_fee_pence', '50', 'Fee for early cashout in pence'),
  ('weekly_payout_day', '"monday"', 'Day of week for automatic weekly payouts'),
  ('preauth_buffer_percent', '20', 'Pre-authorization buffer percentage'),
  ('preauth_min_buffer_pence', '200', 'Minimum pre-auth buffer in pence'),
  ('preauth_max_buffer_pence', '2000', 'Maximum pre-auth buffer in pence'),
  ('payouts_enabled', 'true', 'Whether driver payouts are enabled globally')
ON CONFLICT (setting_key) DO NOTHING;

-- Enable RLS on new tables
ALTER TABLE public.payout_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_items ENABLE ROW LEVEL SECURITY;

-- RLS policies for payout_batches (admin only)
CREATE POLICY "Admins can view all payout batches"
  ON public.payout_batches FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can create payout batches"
  ON public.payout_batches FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update payout batches"
  ON public.payout_batches FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- RLS policies for payout_items (admin only)
CREATE POLICY "Admins can view all payout items"
  ON public.payout_items FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can create payout items"
  ON public.payout_items FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update payout items"
  ON public.payout_items FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_payout_batches_status ON public.payout_batches(status);
CREATE INDEX IF NOT EXISTS idx_payout_batches_run_date ON public.payout_batches(run_date);
CREATE INDEX IF NOT EXISTS idx_payout_batches_kind ON public.payout_batches(kind);
CREATE INDEX IF NOT EXISTS idx_payout_items_batch_id ON public.payout_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_driver_id ON public.payout_items(driver_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_status ON public.payout_items(status);
CREATE INDEX IF NOT EXISTS idx_trips_payment_status ON public.trips(payment_status);
CREATE INDEX IF NOT EXISTS idx_trips_payment_method ON public.trips(payment_method);
CREATE INDEX IF NOT EXISTS idx_trips_completed_at ON public.trips(completed_at);

-- Create trigger for updated_at on payout tables
CREATE OR REPLACE TRIGGER update_payout_batches_updated_at
  BEFORE UPDATE ON public.payout_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE TRIGGER update_payout_items_updated_at
  BEFORE UPDATE ON public.payout_items
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();