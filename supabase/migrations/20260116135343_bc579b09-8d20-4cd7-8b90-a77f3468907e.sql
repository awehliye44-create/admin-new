-- Add fare breakdown columns to trips table (storing in minor units - pence)
ALTER TABLE public.trips 
ADD COLUMN IF NOT EXISTS gross_fare_pence integer,
ADD COLUMN IF NOT EXISTS commission_pence integer,
ADD COLUMN IF NOT EXISTS driver_net_pence integer,
ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

-- Create index on payment_status for efficient queries
CREATE INDEX IF NOT EXISTS idx_trips_payment_status ON public.trips(payment_status);
CREATE INDEX IF NOT EXISTS idx_trips_stripe_payment_intent ON public.trips(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- Create driver wallet/ledger table
CREATE TABLE IF NOT EXISTS public.driver_ledger (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  entry_type text NOT NULL,
  amount_pence integer NOT NULL,
  currency_code text NOT NULL DEFAULT 'GBP',
  description text,
  reference_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Add entry_type constraint
ALTER TABLE public.driver_ledger 
ADD CONSTRAINT driver_ledger_entry_type_check 
CHECK (entry_type IN (
  'CASH_COMMISSION_DEBT',
  'TRIP_EARNING_NET',
  'PAYOUT',
  'EARLY_CASHOUT',
  'CASHOUT_FEE',
  'ADJUSTMENT',
  'BONUS'
));

-- Create indexes for efficient queries
CREATE INDEX idx_driver_ledger_driver_id ON public.driver_ledger(driver_id);
CREATE INDEX idx_driver_ledger_trip_id ON public.driver_ledger(trip_id);
CREATE INDEX idx_driver_ledger_entry_type ON public.driver_ledger(entry_type);
CREATE INDEX idx_driver_ledger_created_at ON public.driver_ledger(created_at DESC);

-- Enable RLS on driver_ledger
ALTER TABLE public.driver_ledger ENABLE ROW LEVEL SECURITY;

-- RLS policies for driver_ledger
CREATE POLICY "Admins can manage all ledger entries"
ON public.driver_ledger FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Drivers can view own ledger entries"
ON public.driver_ledger FOR SELECT
USING (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()));

-- Create a view for driver wallet balance (calculated from ledger)
CREATE OR REPLACE VIEW public.driver_wallet_balance AS
SELECT 
  d.id as driver_id,
  d.first_name,
  d.last_name,
  d.email,
  COALESCE(SUM(l.amount_pence), 0) as available_pence,
  COALESCE(SUM(CASE WHEN l.amount_pence < 0 THEN l.amount_pence ELSE 0 END), 0) as total_debt_pence,
  COALESCE(SUM(CASE WHEN l.amount_pence > 0 THEN l.amount_pence ELSE 0 END), 0) as total_earnings_pence,
  COUNT(DISTINCT l.trip_id) as trip_count
FROM public.drivers d
LEFT JOIN public.driver_ledger l ON d.id = l.driver_id
GROUP BY d.id, d.first_name, d.last_name, d.email;

-- Function to record cash trip commission debt
CREATE OR REPLACE FUNCTION public.record_cash_trip_completion(
  p_trip_id uuid,
  p_driver_id uuid,
  p_gross_fare_pence integer,
  p_commission_pence integer,
  p_currency_code text DEFAULT 'GBP'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ledger_id uuid;
BEGIN
  -- Update trip with fare breakdown
  UPDATE trips SET
    gross_fare_pence = p_gross_fare_pence,
    commission_pence = p_commission_pence,
    driver_net_pence = p_gross_fare_pence - p_commission_pence,
    payment_status = 'collected_cash'
  WHERE id = p_trip_id;

  -- Create CASH_COMMISSION_DEBT entry (negative amount = debt)
  INSERT INTO driver_ledger (
    driver_id,
    trip_id,
    entry_type,
    amount_pence,
    currency_code,
    description
  ) VALUES (
    p_driver_id,
    p_trip_id,
    'CASH_COMMISSION_DEBT',
    -p_commission_pence,
    p_currency_code,
    'Commission owed from cash trip'
  )
  RETURNING id INTO v_ledger_id;

  RETURN v_ledger_id;
END;
$$;

-- Function to record digital trip earnings (called after payment captured)
CREATE OR REPLACE FUNCTION public.record_digital_trip_payment(
  p_trip_id uuid,
  p_driver_id uuid,
  p_gross_fare_pence integer,
  p_commission_pence integer,
  p_stripe_payment_intent_id text,
  p_currency_code text DEFAULT 'GBP'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_net_pence integer;
  v_ledger_id uuid;
BEGIN
  v_driver_net_pence := p_gross_fare_pence - p_commission_pence;

  -- Update trip with fare breakdown and payment confirmation
  UPDATE trips SET
    gross_fare_pence = p_gross_fare_pence,
    commission_pence = p_commission_pence,
    driver_net_pence = v_driver_net_pence,
    payment_status = 'captured',
    stripe_payment_intent_id = p_stripe_payment_intent_id
  WHERE id = p_trip_id;

  -- Create TRIP_EARNING_NET entry (positive amount = credit)
  INSERT INTO driver_ledger (
    driver_id,
    trip_id,
    entry_type,
    amount_pence,
    currency_code,
    description,
    reference_id
  ) VALUES (
    p_driver_id,
    p_trip_id,
    'TRIP_EARNING_NET',
    v_driver_net_pence,
    p_currency_code,
    'Net earnings from digital payment trip',
    p_stripe_payment_intent_id
  )
  RETURNING id INTO v_ledger_id;

  RETURN v_ledger_id;
END;
$$;

-- Function to get driver wallet balance
CREATE OR REPLACE FUNCTION public.get_driver_wallet_balance(p_driver_id uuid)
RETURNS TABLE(
  available_pence bigint,
  can_payout boolean,
  can_early_cashout boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance bigint;
BEGIN
  SELECT COALESCE(SUM(amount_pence), 0) INTO v_balance
  FROM driver_ledger
  WHERE driver_id = p_driver_id;

  RETURN QUERY SELECT 
    v_balance as available_pence,
    (v_balance > 0) as can_payout,
    (v_balance > 50) as can_early_cashout; -- 50p minimum for early cashout fee
END;
$$;