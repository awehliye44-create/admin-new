
-- =====================================================
-- ONECAB Payment System: trip_finance table
-- Single source of truth for trip financial records
-- =====================================================

-- Create trip_finance table with all fare components
CREATE TABLE public.trip_finance (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL,
  service_area_id UUID REFERENCES public.service_areas(id),
  
  -- Fare components (all in pence)
  base_fare_pence INTEGER NOT NULL DEFAULT 0,
  pickup_waiting_charge_pence INTEGER NOT NULL DEFAULT 0,
  stop_waiting_charge_pence INTEGER NOT NULL DEFAULT 0,
  stop_modification_charge_pence INTEGER NOT NULL DEFAULT 0,
  destination_change_charge_pence INTEGER NOT NULL DEFAULT 0,
  extras_charge_pence INTEGER NOT NULL DEFAULT 0,
  tip_amount_pence INTEGER NOT NULL DEFAULT 0,
  
  -- Calculated totals
  commissionable_subtotal_pence INTEGER NOT NULL DEFAULT 0,
  commission_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 20.00,
  platform_commission_pence INTEGER NOT NULL DEFAULT 0,
  driver_net_before_tip_pence INTEGER NOT NULL DEFAULT 0,
  driver_total_earnings_pence INTEGER NOT NULL DEFAULT 0,
  final_trip_total_pence INTEGER NOT NULL DEFAULT 0,
  
  -- Payment details
  payment_method TEXT NOT NULL DEFAULT 'CASH',
  currency_code TEXT NOT NULL DEFAULT 'GBP',
  
  -- Stripe Connect fields (Destination Charges)
  stripe_payment_intent_id TEXT,
  stripe_application_fee_id TEXT,
  stripe_destination_account_id TEXT,
  stripe_processing_fee_pence INTEGER DEFAULT 0,
  
  -- Cash trip fields
  cash_commission_ledger_id UUID,
  
  -- Debt recovery
  wallet_balance_before_pence INTEGER DEFAULT 0,
  debt_recovery_pence INTEGER DEFAULT 0,
  final_driver_payout_pence INTEGER DEFAULT 0,
  wallet_balance_after_pence INTEGER DEFAULT 0,
  
  -- Settlement status
  settlement_status TEXT NOT NULL DEFAULT 'pending',
  settled_at TIMESTAMP WITH TIME ZONE,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  
  -- Constraints
  CONSTRAINT unique_trip_finance UNIQUE(trip_id),
  CONSTRAINT positive_commission_rate CHECK (commission_rate_pct >= 0 AND commission_rate_pct <= 100),
  CONSTRAINT non_negative_fares CHECK (
    base_fare_pence >= 0 AND
    pickup_waiting_charge_pence >= 0 AND
    stop_waiting_charge_pence >= 0 AND
    stop_modification_charge_pence >= 0 AND
    destination_change_charge_pence >= 0 AND
    extras_charge_pence >= 0 AND
    tip_amount_pence >= 0
  )
);

-- Indexes
CREATE INDEX idx_trip_finance_trip_id ON public.trip_finance(trip_id);
CREATE INDEX idx_trip_finance_driver_id ON public.trip_finance(driver_id);
CREATE INDEX idx_trip_finance_service_area ON public.trip_finance(service_area_id);
CREATE INDEX idx_trip_finance_settlement ON public.trip_finance(settlement_status);
CREATE INDEX idx_trip_finance_created ON public.trip_finance(created_at DESC);
CREATE INDEX idx_trip_finance_payment_method ON public.trip_finance(payment_method);

-- Enable RLS
ALTER TABLE public.trip_finance ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Admins can manage trip_finance"
  ON public.trip_finance FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Drivers can view own trip_finance"
  ON public.trip_finance FOR SELECT
  TO authenticated
  USING (driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid()));

-- Trigger for updated_at
CREATE TRIGGER update_trip_finance_updated_at
  BEFORE UPDATE ON public.trip_finance
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Validation trigger: enforce commission calculation integrity
CREATE OR REPLACE FUNCTION public.validate_trip_finance()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
AS $$
BEGIN
  -- Validate commissionable_subtotal
  NEW.commissionable_subtotal_pence := 
    NEW.base_fare_pence + 
    NEW.pickup_waiting_charge_pence + 
    NEW.stop_waiting_charge_pence + 
    NEW.stop_modification_charge_pence + 
    NEW.destination_change_charge_pence + 
    NEW.extras_charge_pence;
  
  -- Validate platform commission
  NEW.platform_commission_pence := ROUND(NEW.commissionable_subtotal_pence * NEW.commission_rate_pct / 100);
  
  -- Validate driver net (tip is NOT commissionable)
  NEW.driver_net_before_tip_pence := NEW.commissionable_subtotal_pence - NEW.platform_commission_pence;
  NEW.driver_total_earnings_pence := NEW.driver_net_before_tip_pence + NEW.tip_amount_pence;
  
  -- Validate final trip total
  NEW.final_trip_total_pence := NEW.commissionable_subtotal_pence + NEW.tip_amount_pence;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_validate_trip_finance
  BEFORE INSERT OR UPDATE ON public.trip_finance
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_trip_finance();
