-- Add commission_pct column to trips for tier snapshot at settlement
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS commission_pct numeric(5,2);

-- Add comment for clarity
COMMENT ON COLUMN public.trips.commission_pct IS 'Tier commission percentage snapshotted at trip settlement. LOCKED — never recalculated after settlement.';