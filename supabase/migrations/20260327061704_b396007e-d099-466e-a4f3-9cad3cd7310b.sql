
-- Add missing columns for grace period and waiting timer tracking
ALTER TABLE public.trips 
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_grace_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS free_wait_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_waiting_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_waiting_charge_pence integer NOT NULL DEFAULT 0;
