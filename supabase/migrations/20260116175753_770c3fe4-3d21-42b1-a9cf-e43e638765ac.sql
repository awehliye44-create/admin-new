-- Add corporate_account_id to trips for corporate billing
ALTER TABLE public.trips 
ADD COLUMN corporate_account_id UUID REFERENCES public.corporate_accounts(id);

-- Add index for faster lookups
CREATE INDEX idx_trips_corporate_account_id ON public.trips(corporate_account_id);

-- Comment for clarity
COMMENT ON COLUMN public.trips.corporate_account_id IS 'Links trip to a corporate account for billing purposes';